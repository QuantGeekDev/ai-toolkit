import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { Job } from '@prisma/client';
import prisma from '../prisma';
import { ArtifactStore } from '../remote/artifactStore';
import { exportTrainingBundle, inspectTrainingBundle } from '../remote/bundle';
import { bundleWorkerKey, runWorkerPrefix, toObjectKey } from '../remote/keys';
import { safeErrorMessage } from '../remote/redact';
import { RunPodClient, RunPodClientError } from '../remote/runpodClient';
import { getAwsArchiveConfig, getRunPodConfig, validateRunPodConfig } from '../remote/settings';

const digestRequest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

const validationMessage = (result: Awaited<ReturnType<typeof exportTrainingBundle>>): string => {
  const errors = result.validation?.errors || [];
  if (!errors.length) return result.error || 'Training bundle validation failed.';
  return errors
    .slice(0, 8)
    .map(item => `${item.code}: ${item.message}${item.path ? ` (${item.path})` : ''}`)
    .join('; ');
};

export default async function startRemoteJob(job: Job): Promise<void> {
  const active = await prisma.remoteExecution.findFirst({
    where: {
      job_id: job.id,
      state: {
        in: ['preparing', 'uploading', 'submitting', 'submission_unknown', 'queued', 'running', 'stop_requested'],
      },
    },
    orderBy: { attempt: 'desc' },
  });
  if (active) {
    await prisma.job.update({
      where: { id: job.id },
      data: { info: `Remote attempt ${active.attempt} is already ${active.state}.` },
    });
    return;
  }

  const config = await getRunPodConfig();
  const archiveConfig = await getAwsArchiveConfig();
  const configurationErrors = validateRunPodConfig(config);
  if (configurationErrors.length) throw new Error(configurationErrors.join(' '));
  const client = new RunPodClient(config);

  const latest = await prisma.remoteExecution.findFirst({ where: { job_id: job.id }, orderBy: { attempt: 'desc' } });
  const previous = await prisma.remoteExecution.findFirst({
    where: { job_id: job.id, state: { in: ['completed', 'stopped'] }, artifact_sync_state: 'complete' },
    orderBy: { attempt: 'desc' },
  });
  if (job.step > 0 && !previous) {
    throw new Error(
      'Local-to-remote or unverified resume is not supported. Clone this job as a new experiment with step 0, or resume from a verified remote attempt.',
    );
  }
  const attempt = (latest?.attempt || 0) + 1;
  const executionId = randomUUID();
  const runPrefix = runWorkerPrefix(executionId);
  const placeholderRequestKey = digestRequest({ executionId, attempt, nonce: randomUUID() });
  const execution = await prisma.remoteExecution.create({
    data: {
      id: executionId,
      job_id: job.id,
      attempt,
      state: 'preparing',
      phase: 'preflight',
      request_key: placeholderRequestKey,
      endpoint_id: config.endpointId,
      run_prefix: runPrefix,
      worker_image_digest: config.workerImageDigest,
      archive_state: archiveConfig.enabled ? 'pending' : 'disabled',
      parent_execution_id: previous?.id,
      resume_prefix: previous && job.step > 0 ? previous.run_prefix : null,
    },
  });

  try {
    await prisma.job.update({
      where: { id: job.id },
      data: { info: 'Checking strict RunPod H100 endpoint configuration...' },
    });
    const preflight = await client.preflight();
    if (!preflight.ok) throw new Error(`RunPod endpoint preflight failed: ${preflight.errors.join(' ')}`);
    await prisma.remoteExecution.update({ where: { id: execution.id }, data: { phase: 'exporting' } });
    await prisma.job.update({
      where: { id: job.id },
      data: { info: 'Validating and exporting remote training bundle...' },
    });
    const bundle = await exportTrainingBundle(job, config);
    if (!bundle.ok || !bundle.bundlePath || !bundle.contentDigest || !bundle.archiveSha256) {
      throw new Error(validationMessage(bundle));
    }
    if (previous && execution.resume_prefix) {
      let priorBundlePath = previous.bundle_local_path;
      const priorExists = priorBundlePath ? await fs.stat(priorBundlePath).catch(() => null) : null;
      if (!priorExists?.isFile()) {
        if (!previous.bundle_object_key || !/^[0-9a-f]{64}$/i.test(previous.bundle_archive_sha256)) {
          throw new Error('The prior attempt has no recoverable immutable bundle for resume validation.');
        }
        priorBundlePath = path.join(config.bundleDirectory, `parent-${previous.bundle_archive_sha256}.tar.gz`);
        const recovered = await new ArtifactStore(config).downloadFile(
          previous.bundle_object_key,
          priorBundlePath,
          previous.bundle_archive_sha256,
        );
        if (!recovered) throw new Error('The prior immutable bundle is missing from the RunPod network volume.');
        await prisma.remoteExecution.update({
          where: { id: previous.id },
          data: { bundle_local_path: priorBundlePath },
        });
      }
      const prior = await inspectTrainingBundle(priorBundlePath);
      const priorCompatibility = prior.manifest?.training?.resumeCompatibilitySha256;
      const nextCompatibility = bundle.manifest?.training?.resumeCompatibilitySha256;
      if (!priorCompatibility || priorCompatibility !== nextCompatibility) {
        throw new Error(
          'Resume blocked: dataset, model, trigger, seed, optimizer, network, precision, or another non-resumable setting changed.',
        );
      }
      const nextSteps = Number(JSON.parse(job.job_config)?.config?.process?.[0]?.train?.steps);
      if (!Number.isFinite(nextSteps) || nextSteps <= job.step) {
        throw new Error(`Resume target must be greater than the verified step ${job.step}.`);
      }
    }
    const workerBundleKey = bundleWorkerKey(bundle.contentDigest, bundle.archiveSha256);
    const objectKey = toObjectKey(workerBundleKey);
    const requestKey = digestRequest({
      schemaVersion: 1,
      executionId,
      bundleContentDigest: bundle.contentDigest,
      bundleArchiveSha256: bundle.archiveSha256,
      workerImageDigest: config.workerImageDigest,
      attempt,
    });
    await prisma.remoteExecution.update({
      where: { id: execution.id },
      data: {
        state: 'uploading',
        phase: 'uploading_bundle',
        request_key: requestKey,
        bundle_content_digest: bundle.contentDigest,
        bundle_archive_sha256: bundle.archiveSha256,
        bundle_object_key: objectKey,
        bundle_local_path: bundle.bundlePath,
      },
    });
    await prisma.job.update({
      where: { id: job.id },
      data: { info: 'Uploading immutable bundle to the RunPod network volume...' },
    });
    await new ArtifactStore(config).putImmutableFile(objectKey, bundle.bundlePath, bundle.archiveSha256);

    const currentJob = await prisma.job.findUnique({ where: { id: job.id }, select: { stop: true } });
    if (currentJob?.stop) {
      const now = new Date();
      await prisma.$transaction([
        prisma.remoteExecution.update({
          where: { id: execution.id },
          data: {
            state: 'stopped',
            phase: 'cancelled_before_submission',
            stop_requested_at: now,
            finished_at: now,
            artifact_sync_state: 'not_available',
          },
        }),
        prisma.job.update({
          where: { id: job.id },
          data: { status: 'stopped', stop: false, info: 'Remote preparation stopped before GPU submission.' },
        }),
      ]);
      return;
    }

    const input = {
      schemaVersion: 1,
      executionId,
      requestKey,
      bundleKey: workerBundleKey,
      bundleContentDigest: bundle.contentDigest,
      bundleArchiveSha256: bundle.archiveSha256,
      runPrefix,
      expectedWorkerImageDigest: config.workerImageDigest,
      ...(execution.resume_prefix ? { resumePrefix: execution.resume_prefix } : {}),
    };
    await prisma.remoteExecution.update({
      where: { id: execution.id },
      data: { state: 'submitting', phase: 'submitting' },
    });
    await prisma.job.update({ where: { id: job.id }, data: { info: 'Submitting H100 job to RunPod...' } });
    const submitted = await client.submit(input);
    await prisma.remoteExecution.update({
      where: { id: execution.id },
      data: {
        provider_job_id: submitted.id,
        state: submitted.status === 'IN_PROGRESS' ? 'running' : 'queued',
        phase: submitted.status === 'IN_PROGRESS' ? 'starting_worker' : 'waiting_for_worker',
        submitted_at: new Date(),
      },
    });
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: 'running',
        info:
          submitted.status === 'IN_PROGRESS' ? 'Starting remote H100 worker...' : 'Queued on RunPod (scale-to-zero).',
      },
    });
  } catch (error) {
    const message = safeErrorMessage(error);
    const ambiguous = error instanceof RunPodClientError && error.ambiguous;
    await prisma.remoteExecution.update({
      where: { id: execution.id },
      data: {
        state: ambiguous ? 'submission_unknown' : 'error',
        phase: ambiguous ? 'reconciling_submission' : 'failed',
        error_code: error instanceof RunPodClientError ? error.code : 'REMOTE_PREPARATION_FAILED',
        error_message: message,
        ...(ambiguous ? {} : { finished_at: new Date() }),
      },
    });
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: ambiguous ? 'running' : 'error',
        info: ambiguous
          ? 'RunPod submission acknowledgement was lost; waiting for durable worker state before retrying.'
          : message,
      },
    });
    if (!ambiguous) throw error;
  }
}
