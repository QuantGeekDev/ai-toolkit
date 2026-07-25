import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { Job, RemoteExecution } from '@prisma/client';
import prisma from '../prisma';
import { getTrainingFolder } from '../paths';
import { ArtifactStore } from '../remote/artifactStore';
import { toObjectKey } from '../remote/keys';
import { safeErrorMessage } from '../remote/redact';
import { RunPodClient } from '../remote/runpodClient';
import { AwsArchiveConfig, getAwsArchiveConfig, getRunPodConfig, validateRunPodConfig } from '../remote/settings';
import { archiveRemoteExecution } from '../remote/awsArchive';

type Progress = {
  sequence?: number;
  timestamp?: number;
  phase?: string;
  info?: string;
  step?: number;
  totalSteps?: number;
  speed?: string;
};

type RemoteResult = {
  status?: string;
  finalStep?: number;
  actualGpu?: string;
  finishedAt?: number;
  artifactIndexSha256?: string;
  error?: { code?: string; message?: string };
};

type ArtifactIndex = {
  artifacts?: Array<{ path: string; role?: string; bytes?: number; sha256?: string }>;
};

type LiveArtifactIndex = ArtifactIndex & { schemaVersion?: number; executionId?: string };

const ACTIVE_STATES = [
  'preparing',
  'uploading',
  'submitting',
  'submission_unknown',
  'queued',
  'running',
  'stop_requested',
];
let nextRun = 0;

const safeArtifactDestination = (root: string, relative: string): string => {
  const portable = relative.replace(/\\/g, '/');
  if (
    !portable ||
    portable.startsWith('/') ||
    /^[A-Za-z]:/.test(portable) ||
    portable.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Worker returned unsafe artifact path: ${relative}`);
  }
  const destination = path.resolve(root, ...portable.split('/'));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!destination.startsWith(prefix)) throw new Error(`Worker artifact escapes the output directory: ${relative}`);
  return destination;
};

const syncLiveFiles = async (
  store: ArtifactStore,
  execution: RemoteExecution,
  job: Job,
  outputDirectory: string,
): Promise<number> => {
  const outputPrefix = `${execution.run_prefix}/output/${job.name}`;
  const logKey = toObjectKey(`${outputPrefix}/log.txt`);
  const head = await store.head(logKey);
  let offset = execution.last_log_offset;
  if (head && head.size > offset) {
    const range = await store.getBuffer(logKey, `bytes=${offset}-`);
    if (range?.body.length) {
      let bytes = range.body;
      if (!range.contentRange && offset > 0) {
        // Some S3-compatible gateways ignore Range and return the whole file.
        // Slice only when the response is demonstrably the complete object;
        // otherwise fail rather than duplicate/corrupt the local log cursor.
        if (range.body.length !== head.size) throw new Error('RunPod S3 returned an ambiguous log range response.');
        bytes = range.body.subarray(offset);
      }
      await fs.mkdir(outputDirectory, { recursive: true });
      await fs.appendFile(path.join(outputDirectory, 'log.txt'), bytes);
      offset += bytes.length;
    }
  }
  await store.downloadFile(
    toObjectKey(`${execution.run_prefix}/state/loss_log.db`),
    path.join(outputDirectory, 'loss_log.db'),
  );
  const samples = await store.list(toObjectKey(`${outputPrefix}/samples`));
  for (const sample of samples) {
    const relative = sample.key.slice(toObjectKey(`${outputPrefix}/`).length);
    const destination = safeArtifactDestination(outputDirectory, relative);
    const local = await fs.stat(destination).catch(() => null);
    if (!local || local.size !== sample.size) await store.downloadFile(sample.key, destination);
  }
  const liveIndex = await store.getJson<LiveArtifactIndex>(
    toObjectKey(`${execution.run_prefix}/state/live-artifacts.json`),
  );
  if (liveIndex) {
    if (
      liveIndex.schemaVersion !== 1 ||
      liveIndex.executionId !== execution.id ||
      !Array.isArray(liveIndex.artifacts)
    ) {
      throw new Error('Remote live artifact index has an invalid identity.');
    }
    if (liveIndex.artifacts.length > 1_000) throw new Error('Remote live artifact index exceeds the safety limit.');
    const receiptPath = path.join(outputDirectory, '.remote-live-artifacts.json');
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8').catch(() => '{}')) as Record<string, string>;
    let changed = false;
    for (const artifact of liveIndex.artifacts) {
      const sha256 = String(artifact.sha256 || '');
      if (
        artifact.role !== 'lora-checkpoint' ||
        !artifact.path ||
        !artifact.path.endsWith('.safetensors') ||
        !/^[0-9a-f]{64}$/i.test(sha256)
      ) {
        throw new Error('Remote live artifact index contains an invalid entry.');
      }
      const destination = safeArtifactDestination(outputDirectory, artifact.path);
      if (receipt[artifact.path] === sha256 && (await fs.stat(destination).catch(() => null))?.isFile()) continue;
      const source = toObjectKey(`${outputPrefix}/${artifact.path}`);
      if (!(await store.downloadFile(source, destination, sha256))) {
        throw new Error(`Verified remote checkpoint disappeared before download: ${artifact.path}`);
      }
      receipt[artifact.path] = sha256;
      changed = true;
    }
    if (changed) {
      const temporary = `${receiptPath}.part-${process.pid}`;
      await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      await fs.rename(temporary, receiptPath);
    }
  }
  return offset;
};

const syncFinalArtifacts = async (
  store: ArtifactStore,
  execution: RemoteExecution,
  job: Job,
  outputDirectory: string,
  result: RemoteResult,
): Promise<void> => {
  const indexKey = toObjectKey(`${execution.run_prefix}/artifacts.json`);
  const indexObject = await store.getBuffer(indexKey);
  if (!indexObject) throw new Error('Remote result is final but artifacts.json is missing.');
  const actualIndexSha256 = createHash('sha256').update(indexObject.body).digest('hex');
  if (
    !/^[0-9a-f]{64}$/i.test(String(result.artifactIndexSha256 || '')) ||
    actualIndexSha256 !== result.artifactIndexSha256
  ) {
    throw new Error('Remote artifact index checksum does not match result.json.');
  }
  let index: ArtifactIndex & { schemaVersion?: number; executionId?: string };
  try {
    index = JSON.parse(indexObject.body.toString('utf8'));
  } catch {
    throw new Error('Remote artifacts.json is not valid JSON.');
  }
  if (!index || !Array.isArray(index.artifacts))
    throw new Error('Remote result is final but artifacts.json is missing.');
  if (index.schemaVersion !== 1 || index.executionId !== execution.id)
    throw new Error('Remote artifact index identity does not match the execution.');
  if (index.artifacts.length > 10_000) throw new Error('Remote artifact index exceeds the safety limit.');
  const markerName = result.status === 'stopped' ? 'STOPPED' : 'COMPLETE';
  const marker = await store.getBuffer(toObjectKey(`${execution.run_prefix}/${markerName}`));
  if (!marker || marker.body.toString('utf8').trim() !== result.artifactIndexSha256) {
    throw new Error('Remote artifact completion marker does not match result.json.');
  }
  for (const artifact of index.artifacts) {
    if (!artifact.path || !/^[0-9a-f]{64}$/i.test(String(artifact.sha256 || ''))) {
      throw new Error('Remote artifact index contains an invalid entry.');
    }
    const destination = safeArtifactDestination(outputDirectory, artifact.path);
    const source = toObjectKey(`${execution.run_prefix}/output/${job.name}/${artifact.path}`);
    await store.downloadFile(source, destination, artifact.sha256);
  }
  await fs.writeFile(
    path.join(outputDirectory, '.remote-execution.json'),
    `${JSON.stringify({ executionId: execution.id, attempt: execution.attempt, result, artifacts: index.artifacts }, null, 2)}\n`,
    'utf8',
  );
};

const reconcileOne = async (
  execution: RemoteExecution & { job: Job },
  store: ArtifactStore,
  client: RunPodClient,
  trainingRoot: string,
  archiveConfig: AwsArchiveConfig,
  remoteTtlMs: number,
): Promise<void> => {
  const { job } = execution;
  const outputDirectory = path.join(trainingRoot, job.name);
  await fs.mkdir(outputDirectory, { recursive: true });
  let providerStatus = '';
  if (execution.provider_job_id) {
    try {
      const status = await client.status(execution.provider_job_id);
      providerStatus = String(status.status || '').toUpperCase();
    } catch (error) {
      console.warn(`RunPod status unavailable for ${execution.id}:`, safeErrorMessage(error));
    }
  }

  const progress = await store.getJson<Progress>(toObjectKey(`${execution.run_prefix}/state/current.json`));
  const result = await store.getJson<RemoteResult>(toObjectKey(`${execution.run_prefix}/result.json`));
  const claim = await store.getJson<Record<string, unknown>>(toObjectKey(`${execution.run_prefix}/claim.json`));
  const update: any = {};
  const jobUpdate: any = {};

  if (progress && Number(progress.sequence || 0) >= execution.last_event_sequence) {
    const step = Math.max(job.step, Math.max(0, Math.trunc(Number(progress.step || 0))));
    update.last_event_sequence = Math.trunc(Number(progress.sequence || 0));
    update.progress_json = JSON.stringify(progress);
    update.phase = String(progress.phase || execution.phase);
    update.last_heartbeat_at = progress.timestamp ? new Date(progress.timestamp * 1000) : new Date();
    if (!execution.started_at && progress.phase) update.started_at = new Date();
    jobUpdate.step = step;
    if (Number.isFinite(Number(progress.totalSteps)) && Number(progress.totalSteps) > 0) {
      jobUpdate.total_steps = Math.trunc(Number(progress.totalSteps));
    }
    jobUpdate.info = String(progress.info || `Remote ${progress.phase || 'training'}`).slice(0, 1000);
    jobUpdate.speed_string = String(progress.speed || '').slice(0, 200);
    if (!result) update.state = job.stop ? 'stop_requested' : 'running';
  } else if (claim && ['submission_unknown', 'queued', 'submitting'].includes(execution.state)) {
    update.state = job.stop ? 'stop_requested' : 'running';
    update.phase = 'worker_claimed';
    jobUpdate.info = 'Remote worker claimed the execution; waiting for progress.';
  } else if (providerStatus === 'IN_QUEUE') {
    update.state = 'queued';
    update.phase = 'waiting_for_worker';
    jobUpdate.info = 'Queued on RunPod (scale-to-zero).';
  } else if (providerStatus === 'IN_PROGRESS') {
    update.state = job.stop ? 'stop_requested' : 'running';
    update.phase = execution.phase || 'starting_worker';
  }

  if (job.stop && !result) {
    const stopKey = toObjectKey(`${execution.run_prefix}/control/stop.json`);
    if (!(await store.head(stopKey))) {
      await store.putJson(stopKey, {
        schemaVersion: 1,
        executionId: execution.id,
        requestedAt: new Date().toISOString(),
      });
    }
    update.state = 'stop_requested';
    update.stop_requested_at = execution.stop_requested_at || new Date();
    jobUpdate.status = 'stopping';
    jobUpdate.info = 'Stop requested; waiting for a safe remote checkpoint.';
  }

  const newOffset = await syncLiveFiles(store, execution, job, outputDirectory);
  if (newOffset !== execution.last_log_offset) update.last_log_offset = newOffset;

  if (result) {
    if ((result as any).executionId && (result as any).executionId !== execution.id) {
      throw new Error('Remote result identity does not match the execution.');
    }
    update.result_json = JSON.stringify(result);
    update.finished_at = result.finishedAt ? new Date(result.finishedAt * 1000) : new Date();
    update.actual_gpu = result.actualGpu || execution.actual_gpu;
    if (result.status === 'failed') {
      update.state = 'error';
      update.phase = 'failed';
      update.error_code = result.error?.code || 'REMOTE_TRAINING_FAILED';
      update.error_message = String(result.error?.message || 'Remote training failed.').slice(0, 1000);
      update.artifact_sync_state = 'not_available';
      jobUpdate.status = 'error';
      jobUpdate.info = update.error_message;
    } else if (result.status === 'completed' || result.status === 'stopped') {
      if (
        !String(result.actualGpu || '')
          .toUpperCase()
          .includes('H100')
      ) {
        throw new Error(`Remote worker did not attest an H100 GPU (reported ${result.actualGpu || 'unknown'}).`);
      }
      update.state = result.status;
      update.phase = 'syncing_artifacts';
      update.artifact_sync_state = 'syncing';
      await syncFinalArtifacts(store, execution, job, outputDirectory, result);
      update.phase = result.status;
      update.artifact_sync_state = 'complete';
      if (execution.archive_state === 'pending' && archiveConfig.enabled) {
        try {
          update.archive_prefix = await archiveRemoteExecution(archiveConfig, execution, job, outputDirectory);
          update.archive_state = 'complete';
          update.archive_error = null;
        } catch (error) {
          update.archive_state = 'error';
          update.archive_error = safeErrorMessage(error);
        }
      }
      const returnToQueue = result.status === 'stopped' && job.return_to_queue;
      jobUpdate.status = returnToQueue ? 'queued' : result.status;
      jobUpdate.stop = false;
      jobUpdate.return_to_queue = false;
      jobUpdate.pid = null;
      jobUpdate.step = Math.max(job.step, Math.trunc(Number(result.finalStep || 0)));
      jobUpdate.info = returnToQueue
        ? 'Remote training stopped safely; artifacts verified and job returned to the paused queue.'
        : `Remote training ${result.status}; artifacts verified locally.`;
    }
  } else if (['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(providerStatus)) {
    const forceCancelled = execution.error_code === 'FORCE_CANCEL_REQUESTED' && providerStatus === 'CANCELLED';
    update.state = forceCancelled ? 'stopped' : 'error';
    update.phase = forceCancelled ? 'force_cancelled' : 'failed';
    update.finished_at = new Date();
    update.artifact_sync_state = forceCancelled ? 'partial' : execution.artifact_sync_state;
    update.error_code = forceCancelled ? 'FORCE_CANCELLED' : `RUNPOD_${providerStatus}`;
    update.error_message = forceCancelled
      ? 'RunPod confirmed force cancellation; only previously mirrored artifacts are trusted.'
      : `RunPod reported ${providerStatus} without a durable worker result.`;
    jobUpdate.status = forceCancelled ? 'stopped' : 'error';
    jobUpdate.stop = false;
    jobUpdate.info = update.error_message;
  } else if (
    execution.state === 'submission_unknown' &&
    Date.now() - execution.created_at.getTime() > remoteTtlMs + 10 * 60 * 1000 &&
    !claim
  ) {
    update.state = job.stop ? 'stopped' : 'error';
    update.phase = 'submission_unresolved';
    update.finished_at = new Date();
    update.error_code = 'REMOTE_SUBMISSION_UNKNOWN';
    update.error_message = `No RunPod acknowledgement or durable worker claim appeared before the ${Math.round(remoteTtlMs / 60000)}-minute request TTL; the job was not retried automatically.`;
    jobUpdate.status = job.stop ? 'stopped' : 'error';
    jobUpdate.stop = false;
    jobUpdate.info = update.error_message;
  } else if (
    execution.state === 'submission_unknown' &&
    Date.now() - execution.created_at.getTime() > 10 * 60 * 1000 &&
    !claim
  ) {
    jobUpdate.info =
      'Submission acknowledgement is still unknown. No retry will be issued; durable storage is monitored through the request TTL.';
  }

  const operations = [];
  if (Object.keys(update).length)
    operations.push(prisma.remoteExecution.update({ where: { id: execution.id }, data: update }));
  if (Object.keys(jobUpdate).length) operations.push(prisma.job.update({ where: { id: job.id }, data: jobUpdate }));
  if (operations.length) await prisma.$transaction(operations);
};

export default async function reconcileRemoteExecutions(force = false): Promise<void> {
  if (!force && Date.now() < nextRun) return;
  nextRun = Date.now() + 3000;
  const trainingRoot = await getTrainingFolder();
  const archiveConfig = await getAwsArchiveConfig();
  const pendingArchives = await prisma.remoteExecution.findMany({
    where: {
      state: { in: ['completed', 'stopped'] },
      artifact_sync_state: 'complete',
      archive_state: 'pending',
    },
    include: { job: true },
  });
  for (const execution of pendingArchives) {
    try {
      const archivePrefix = await archiveRemoteExecution(
        archiveConfig,
        execution,
        execution.job,
        path.join(trainingRoot, execution.job.name),
      );
      await prisma.remoteExecution.update({
        where: { id: execution.id },
        data: { archive_state: 'complete', archive_prefix: archivePrefix, archive_error: null },
      });
    } catch (error) {
      await prisma.remoteExecution.update({
        where: { id: execution.id },
        data: { archive_state: 'error', archive_error: safeErrorMessage(error) },
      });
    }
  }
  const executions = await prisma.remoteExecution.findMany({
    where: {
      OR: [
        { state: { in: ACTIVE_STATES } },
        {
          state: { in: ['completed', 'stopped'] },
          artifact_sync_state: { in: ['pending', 'retrying', 'syncing'] },
        },
      ],
    },
    include: { job: true },
    orderBy: { created_at: 'asc' },
  });
  if (!executions.length) return;
  const config = await getRunPodConfig();
  const errors = validateRunPodConfig(config);
  if (errors.length) {
    console.warn('Remote reconciliation is paused:', errors.join(' '));
    return;
  }
  const store = new ArtifactStore(config);
  const client = new RunPodClient(config);
  for (const execution of executions) {
    try {
      await reconcileOne(execution, store, client, trainingRoot, archiveConfig, config.ttlMs);
    } catch (error) {
      const message = safeErrorMessage(error);
      console.error(`Error reconciling remote execution ${execution.id}:`, message);
      await prisma.remoteExecution.update({
        where: { id: execution.id },
        data: {
          artifact_sync_state:
            execution.state === 'completed' || execution.state === 'stopped'
              ? 'retrying'
              : execution.artifact_sync_state,
          error_message: message,
        },
      });
    }
  }
}
