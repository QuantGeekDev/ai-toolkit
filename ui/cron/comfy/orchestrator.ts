import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ComfyWorkspace, Job } from '@prisma/client';
import prisma from '../prisma';
import { getTrainingFolder } from '../paths';
import { safeErrorMessage } from '../remote/redact';
import { buildWorkspaceBundle, ComfyBundleError, hashFile } from './bundle';
import { ComfyControlClient, ComfyControlError, type RemoteWorkspaceStatus } from './controlClient';
import { deriveControllerToken, deriveWorkspaceSecret } from './secrets';
import { assertComfyTransition, COMFY_OPENABLE_STATES, isComfyTerminalState } from './state';
import { ComfyPodClient, ComfyPodClientError, type CreateManagedPodInput, type ManagedPod } from './podClient';
import { ComfySftpError, ComfySftpTransport } from './sftp';
import { getRunPodComfyConfig, type RunPodComfyConfig, validateRunPodComfyConfig } from './settings';

type WorkspaceWithJob = ComfyWorkspace & { job: Job };

const OWNER = `${process.pid}-${crypto.randomUUID()}`;
const LEASE_MS = 45_000;
const RETRY_DELAY_MS = 10_000;
const ORPHAN_SWEEP_MS = 60_000;
const ACTIVE_STATES = [
  'requested',
  'preparing_bundle',
  'waiting_for_capacity',
  'provisioning',
  'provisioning_unknown',
  'booting',
  'transferring',
  'validating',
  'ready',
  'busy',
  'idle_grace',
  'syncing_outputs',
  'terminating',
];

const log = (workspace: WorkspaceWithJob, event: string, fields: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({
      service: 'comfy-workspace',
      event,
      workspaceId: workspace.id,
      jobId: workspace.job_id,
      podId: workspace.provider_pod_id || undefined,
      state: workspace.state,
      phase: workspace.phase,
      ...fields,
    }),
  );

const update = (workspace: WorkspaceWithJob, data: Record<string, unknown>) => {
  if (typeof data.state === 'string' && data.state !== workspace.state) {
    assertComfyTransition(workspace.state, data.state);
  }
  return prisma.comfyWorkspace.update({ where: { id: workspace.id }, data });
};

const failAbsent = async (workspace: WorkspaceWithJob, code: string, message: string) => {
  await update(workspace, {
    state: 'failed_confirmed_absent',
    phase: 'failed',
    error_code: code,
    error_message: safeErrorMessage(message),
    active_lease_key: null,
    lease_owner: null,
    lease_expires_at: null,
    terminated_at: new Date(),
  });
};

const requestInput = (
  workspace: WorkspaceWithJob,
  config: RunPodComfyConfig,
  terminateAfter: Date,
): CreateManagedPodInput => ({
  workspaceId: workspace.id,
  name: workspace.managed_pod_name,
  gpuId: config.gpuIds[0],
  containerDiskGb: workspace.container_disk_gb,
  terminateAfter,
  environment: {
    AITK_WORKSPACE_ID: workspace.id,
    AITK_MANAGED_POD_NAME: workspace.managed_pod_name,
    AITK_CONTROLLER_TOKEN: deriveControllerToken(config.masterSecret, workspace.id),
    AITK_BROWSER_SIGNING_KEY: deriveWorkspaceSecret(config.masterSecret, workspace.id, 'browser').toString('base64url'),
    AITK_IDLE_MINUTES: String(workspace.idle_timeout_minutes),
    AITK_EXPIRES_AT: terminateAfter.toISOString(),
    AITK_IMAGE_DIGEST: config.imageDigest,
    AITK_MODEL_MANIFEST_SHA256: config.modelManifestSha256,
    HF_TOKEN: `{{ RUNPOD_SECRET_${config.hfSecretName} }}`,
    PUBLIC_KEY: config.sshPublicKey,
  },
});

const remoteMarker = (pod: ManagedPod, workspaceId: string): boolean => {
  const env = pod.raw.env;
  if (Array.isArray(env))
    return env.some((item: any) => item?.key === 'AITK_WORKSPACE_ID' && item?.value === workspaceId);
  return Boolean(env && typeof env === 'object' && (env as Record<string, unknown>).AITK_WORKSPACE_ID === workspaceId);
};

const remoteWorkspaceId = (pod: ManagedPod): string | null => {
  const env = pod.raw.env;
  if (Array.isArray(env)) {
    const marker = env.find((item: any) => item?.key === 'AITK_WORKSPACE_ID');
    return typeof marker?.value === 'string' ? marker.value : null;
  }
  const value = env && typeof env === 'object' ? (env as Record<string, unknown>).AITK_WORKSPACE_ID : null;
  return typeof value === 'string' ? value : null;
};

const setProvisioned = async (
  workspace: WorkspaceWithJob,
  pod: ManagedPod,
  config: RunPodComfyConfig,
  expiresAt: Date,
) => {
  const input = requestInput(workspace, config, expiresAt);
  const client = new ComfyPodClient(config);
  const errors = client.verifyIdentity(pod, input);
  if (errors.length) {
    await update(workspace, {
      provider_pod_id: pod.id,
      state: 'terminating',
      phase: 'identity_failed',
      error_code: 'POD_IDENTITY_FAILED',
      error_message: errors.join(' '),
      termination_reason: 'identity_failed',
      termination_requested_at: new Date(),
      termination_mode: 'immediate',
    });
    return;
  }
  await update(workspace, {
    provider_pod_id: pod.id,
    state: 'booting',
    phase: 'pod_starting',
    actual_gpu: pod.gpu || null,
    hourly_rate: pod.hourlyRate,
    estimated_max_cost: pod.hourlyRate == null ? null : pod.hourlyRate * (workspace.max_runtime_minutes / 60),
    provider_started_at: new Date(),
    expires_at: expiresAt,
    public_url: `https://${pod.id}-8188.proxy.runpod.net/`,
  });
};

const terminate = async (workspace: WorkspaceWithJob, config: RunPodComfyConfig) => {
  if (!workspace.provider_pod_id) {
    await update(workspace, {
      state:
        workspace.termination_reason === 'hard_expiry' || workspace.termination_reason === 'idle'
          ? 'expired'
          : 'terminated',
      phase: 'provider_absent',
      active_lease_key: null,
      lease_owner: null,
      lease_expires_at: null,
      terminated_at: new Date(),
    });
    return;
  }
  const client = new ComfyPodClient(config);
  const pod = await client.get(workspace.provider_pod_id);
  if (!pod) {
    const state =
      workspace.termination_reason === 'hard_expiry' ||
      workspace.termination_reason === 'idle' ||
      JSON.parse(workspace.remote_status_json || '{}')?.terminationReason === 'idle'
        ? 'expired'
        : 'terminated';
    await update(workspace, {
      state,
      phase: 'provider_absent',
      active_lease_key: null,
      lease_owner: null,
      lease_expires_at: null,
      terminated_at: new Date(),
    });
    const staging = path.join(config.stagingDirectory, workspace.id);
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  await client.delete(pod.id);
  await update(workspace, {
    phase: 'delete_requested',
    termination_requested_at: workspace.termination_requested_at || new Date(),
  });
};

const pollRemote = async (workspace: WorkspaceWithJob, config: RunPodComfyConfig): Promise<RemoteWorkspaceStatus> => {
  if (!workspace.public_url) throw new Error('Workspace public URL is unavailable.');
  const control = new ComfyControlClient(
    workspace.public_url,
    deriveControllerToken(config.masterSecret, workspace.id),
  );
  const status = await control.status();
  if (status.workspaceId !== workspace.id) throw new Error('Remote workspace identity does not match.');
  if (status.modelManifestSha256 && status.modelManifestSha256 !== config.modelManifestSha256)
    throw new Error('Remote model manifest identity does not match.');
  if (status.imageDigest && status.imageDigest !== config.imageDigest)
    throw new Error('Remote image identity does not match.');
  await update(workspace, {
    last_remote_contact_at: new Date(),
    last_user_activity_at: status.lastUserActivityAt
      ? new Date(status.lastUserActivityAt)
      : workspace.last_user_activity_at,
    last_queue_activity_at: status.lastQueueActivityAt
      ? new Date(status.lastQueueActivityAt)
      : workspace.last_queue_activity_at,
    remote_status_json: JSON.stringify({
      phase: status.phase,
      ready: status.ready,
      modelsVerified: status.modelsVerified,
      comfyVerified: status.comfyVerified,
      queueRunning: status.queueRunning,
      queuePending: status.queuePending,
      idleGraceStartedAt: status.idleGraceStartedAt,
      terminationReason: status.terminationReason,
    }),
  });
  return status;
};

const safeOutputDestination = (root: string, relative: string): string => {
  const portable = relative.replace(/\\/g, '/');
  if (
    !portable ||
    portable.startsWith('/') ||
    /^[A-Za-z]:/.test(portable) ||
    portable.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw new Error('Remote output catalog contains an unsafe path.');
  }
  const destination = path.resolve(root, ...portable.split('/'));
  if (!destination.startsWith(`${path.resolve(root)}${path.sep}`))
    throw new Error('Remote output escapes the job output directory.');
  return destination;
};

const syncOutputs = async (workspace: WorkspaceWithJob, config: RunPodComfyConfig): Promise<void> => {
  if (!workspace.public_url || !workspace.ssh_host || !workspace.ssh_port || !workspace.ssh_host_fingerprint) {
    throw new Error('Workspace output transport is unavailable.');
  }
  const catalog = await new ComfyControlClient(
    workspace.public_url,
    deriveControllerToken(config.masterSecret, workspace.id),
  ).outputs();
  if (catalog.workspaceId !== workspace.id || catalog.files.length > 10_000)
    throw new Error('Remote output catalog identity is invalid.');
  const limit = config.outputAllowanceGb * 1024 ** 3;
  if (catalog.bytes > limit) throw new Error('Remote generated images exceed the configured output allowance.');
  const root = path.join(await getTrainingFolder(), workspace.job.name, 'comfyui-workspaces', workspace.id);
  const transport = new ComfySftpTransport({
    host: workspace.ssh_host,
    port: workspace.ssh_port,
    privateKey: await fs.promises.readFile(config.sshPrivateKeyPath),
    expectedFingerprint: workspace.ssh_host_fingerprint,
  });
  for (const item of catalog.files) {
    if (
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      !/^[0-9a-f]{64}$/i.test(item.sha256) ||
      item.remotePath !== path.posix.join('outputs', item.path)
    ) {
      throw new Error('Remote output catalog contains an invalid entry.');
    }
    const destination = safeOutputDestination(root, item.path);
    const existing = await fs.promises.lstat(destination).catch(() => null);
    if (
      existing?.isFile() &&
      !existing.isSymbolicLink() &&
      existing.size === item.bytes &&
      (await hashFile(destination)) === item.sha256
    ) {
      continue;
    }
    await transport.downloadOutput(item.remotePath, destination, BigInt(item.bytes), item.sha256);
  }
};

const advance = async (workspace: WorkspaceWithJob, config: RunPodComfyConfig) => {
  if (workspace.phase.startsWith('retrying_') && Date.now() - workspace.updated_at.getTime() < RETRY_DELAY_MS) {
    return;
  }
  if (workspace.termination_requested_at && workspace.state !== 'terminating') {
    const shouldSync =
      workspace.termination_mode === 'graceful' &&
      workspace.preserve_outputs &&
      workspace.output_sync_state === 'requested' &&
      (COMFY_OPENABLE_STATES as readonly string[]).includes(workspace.state);
    if (shouldSync && workspace.public_url) {
      await new ComfyControlClient(
        workspace.public_url,
        deriveControllerToken(config.masterSecret, workspace.id),
      ).requestGracefulTermination();
    }
    await update(workspace, {
      state: shouldSync ? 'syncing_outputs' : 'terminating',
      phase: shouldSync ? 'final_output_sync' : 'termination_requested',
    });
    return;
  }
  if (
    workspace.provider_pod_id &&
    ['booting', 'transferring', 'validating', 'ready', 'busy', 'idle_grace', 'syncing_outputs'].includes(
      workspace.state,
    )
  ) {
    const pod = await new ComfyPodClient(config).get(workspace.provider_pod_id);
    if (!pod) {
      await update(workspace, {
        state: 'terminating',
        phase: 'provider_absent',
        termination_reason:
          workspace.expires_at && workspace.expires_at.getTime() <= Date.now() ? 'hard_expiry' : 'provider_absent',
      });
      return;
    }
    if (['STOPPED', 'EXITED', 'TERMINATED'].includes(pod.status)) {
      await update(workspace, {
        state: 'terminating',
        phase: 'pod_not_running',
        termination_reason: 'pod_not_running',
        termination_requested_at: new Date(),
        termination_mode: 'immediate',
      });
      return;
    }
  }
  switch (workspace.state) {
    case 'requested':
      await update(workspace, { state: 'preparing_bundle', phase: 'snapshotting_checkpoints' });
      return;
    case 'preparing_bundle': {
      const bundle = await buildWorkspaceBundle({
        workspace,
        job: workspace.job,
        trainingRoot: await getTrainingFolder(),
        config,
      });
      await prisma.$transaction([
        prisma.comfyWorkspaceArtifact.deleteMany({ where: { workspace_id: workspace.id } }),
        ...bundle.artifacts.map(item =>
          prisma.comfyWorkspaceArtifact.create({
            data: {
              workspace_id: workspace.id,
              role: item.role,
              display_name: item.displayName,
              local_path: item.localPath,
              remote_relative_path: item.remoteRelativePath,
              byte_length: item.byteLength,
              sha256: item.sha256,
              source_size: item.sourceSize,
              source_mtime_ms: item.sourceMtimeMs,
            },
          }),
        ),
        prisma.comfyWorkspace.update({
          where: { id: workspace.id },
          data: {
            state: 'waiting_for_capacity',
            phase: 'capacity_check',
            workflow_name: bundle.workflowName,
            checkpoint_count: bundle.checkpointCount,
            manifest_sha256: bundle.manifestSha256,
            model_manifest_sha256: config.modelManifestSha256,
            bytes_planned: bundle.bytesPlanned,
            container_disk_gb: bundle.containerDiskGb,
          },
        }),
      ]);
      return;
    }
    case 'waiting_for_capacity':
      await update(workspace, { state: 'provisioning', phase: 'creating_secure_h100' });
      return;
    case 'provisioning': {
      const expiresAt = new Date(Date.now() + workspace.max_runtime_minutes * 60_000);
      try {
        const input = requestInput(workspace, config, expiresAt);
        const pod = await new ComfyPodClient(config).create(input);
        await setProvisioned(workspace, pod, config, expiresAt);
      } catch (error) {
        if (error instanceof ComfyPodClientError && error.code === 'POD_CAPACITY') {
          const waitedMs = Date.now() - workspace.created_at.getTime();
          if (waitedMs < config.capacityWaitMinutes * 60_000) {
            await update(workspace, { state: 'waiting_for_capacity', phase: 'capacity_unavailable' });
          } else {
            await failAbsent(
              workspace,
              'CAPACITY_TIMEOUT',
              'No allowed Secure Cloud H100 became available before the capacity deadline.',
            );
          }
          return;
        }
        if (error instanceof ComfyPodClientError && error.ambiguous) {
          await update(workspace, {
            state: 'provisioning_unknown',
            phase: 'reconciling_ambiguous_create',
            error_code: 'POD_CREATE_UNKNOWN',
            error_message: 'RunPod did not confirm whether the Pod was created; reconciling by exact identity.',
          });
          return;
        }
        throw error;
      }
      return;
    }
    case 'provisioning_unknown': {
      const pods = (await new ComfyPodClient(config).findByName(workspace.managed_pod_name)).filter(pod =>
        remoteMarker(pod, workspace.id),
      );
      if (pods.length === 1) {
        await setProvisioned(
          workspace,
          pods[0],
          config,
          new Date(workspace.created_at.getTime() + workspace.max_runtime_minutes * 60_000),
        );
      } else if (pods.length > 1) {
        await update(workspace, {
          state: 'terminating',
          phase: 'duplicate_managed_pods',
          error_code: 'DUPLICATE_MANAGED_PODS',
          error_message: 'RunPod returned duplicate Pods with this exact managed identity.',
          termination_reason: 'duplicate_managed_pods',
          termination_requested_at: new Date(),
        });
        for (const pod of pods) await new ComfyPodClient(config).delete(pod.id);
      } else if (Date.now() - workspace.updated_at.getTime() > 10 * 60_000) {
        await failAbsent(
          workspace,
          'POD_CREATE_NOT_FOUND',
          'No Pod with the exact managed identity appeared after the ambiguous create window.',
        );
      }
      return;
    }
    case 'booting': {
      if (!workspace.provider_pod_id) throw new Error('Provisioned workspace has no Pod ID.');
      const pod = await new ComfyPodClient(config).get(workspace.provider_pod_id);
      if (!pod) {
        await update(workspace, {
          state: 'terminating',
          phase: 'pod_disappeared',
          termination_reason: 'provider_absent',
        });
        return;
      }
      const status = await pollRemote(workspace, config);
      if (status.errorCode) throw new Error(status.errorMessage || status.errorCode);
      if (
        !status.sshHostKeyFingerprint ||
        !pod.sshHost ||
        !pod.sshPort ||
        status.modelsVerified !== true ||
        status.comfyVerified !== true
      ) {
        return;
      }
      await update(workspace, {
        state: 'transferring',
        phase: 'uploading_bundle',
        ssh_host: pod.sshHost,
        ssh_port: pod.sshPort,
        ssh_host_fingerprint: status.sshHostKeyFingerprint,
      });
      return;
    }
    case 'transferring': {
      if (!workspace.ssh_host || !workspace.ssh_port || !workspace.ssh_host_fingerprint)
        throw new Error('SFTP attestation is incomplete.');
      const privateKey = await fs.promises.readFile(config.sshPrivateKeyPath);
      const transport = new ComfySftpTransport({
        host: workspace.ssh_host,
        port: workspace.ssh_port,
        privateKey,
        expectedFingerprint: workspace.ssh_host_fingerprint,
      });
      const artifacts = await prisma.comfyWorkspaceArtifact.findMany({
        where: { workspace_id: workspace.id },
        orderBy: { remote_relative_path: 'asc' },
      });
      let workspaceTransferred = artifacts.reduce((total, item) => total + item.transferred_bytes, BigInt(0));
      for (const artifact of artifacts.filter(item => item.transfer_state !== 'complete')) {
        const base = workspaceTransferred - artifact.transferred_bytes;
        await prisma.comfyWorkspaceArtifact.update({
          where: { id: artifact.id },
          data: { transfer_state: 'uploading', attempts: { increment: 1 } },
        });
        const transferred = await transport.uploadArtifact(artifact, async bytes => {
          await prisma.comfyWorkspaceArtifact.update({
            where: { id: artifact.id },
            data: { transferred_bytes: bytes },
          });
          await update(workspace, { bytes_transferred: base + bytes });
        });
        workspaceTransferred = base + transferred;
        await prisma.comfyWorkspaceArtifact.update({
          where: { id: artifact.id },
          data: { transfer_state: 'complete', transferred_bytes: transferred, error_message: null },
        });
      }
      await transport.commit(path.join(config.stagingDirectory, workspace.id, 'workspace-manifest.json'));
      const status = await new ComfyControlClient(
        workspace.public_url!,
        deriveControllerToken(config.masterSecret, workspace.id),
      ).install(workspace.manifest_sha256);
      if (status.workspaceId !== workspace.id)
        throw new Error('Remote install response has the wrong workspace identity.');
      await update(workspace, {
        state: 'validating',
        phase: 'validating_comfyui',
        bytes_transferred: workspace.bytes_planned,
      });
      return;
    }
    case 'validating': {
      const status = await pollRemote(workspace, config);
      if (status.errorCode) throw new Error(status.errorMessage || status.errorCode);
      if (!status.ready) return;
      await update(workspace, {
        state: status.queueRunning || status.queuePending > 0 ? 'busy' : 'ready',
        phase: 'ready',
        ready_at: workspace.ready_at || new Date(),
      });
      return;
    }
    case 'ready':
    case 'busy':
    case 'idle_grace': {
      if (workspace.preserve_outputs) {
        const due =
          !workspace.output_sync_requested_at ||
          Date.now() - workspace.output_sync_requested_at.getTime() >= 30_000 ||
          workspace.output_sync_state === 'requested';
        if (due) {
          await update(workspace, {
            state: 'syncing_outputs',
            phase: 'mirroring_outputs',
            output_sync_state: 'syncing',
            output_sync_requested_at: new Date(),
          });
          return;
        }
      }
      const status = await pollRemote(workspace, config);
      if (status.terminationReason) {
        await update(workspace, {
          state: 'terminating',
          phase: 'remote_termination',
          termination_reason: status.terminationReason,
          termination_requested_at: new Date(),
        });
      } else if (status.idleGraceStartedAt) {
        await update(workspace, { state: 'idle_grace', phase: 'idle_grace' });
      } else {
        await update(workspace, {
          state: status.queueRunning || status.queuePending > 0 ? 'busy' : 'ready',
          phase: status.queueRunning || status.queuePending > 0 ? 'generation_active' : 'ready',
        });
      }
      return;
    }
    case 'syncing_outputs':
      try {
        await syncOutputs(workspace, config);
        await update(workspace, {
          state: workspace.termination_requested_at ? 'terminating' : 'ready',
          phase: workspace.termination_requested_at ? 'output_sync_complete' : 'ready',
          output_sync_state: 'complete',
          output_sync_error: null,
        });
      } catch (error) {
        await update(workspace, {
          state: workspace.termination_requested_at ? 'terminating' : 'ready',
          phase: workspace.termination_requested_at ? 'output_sync_failed' : 'ready',
          output_sync_state: 'failed',
          output_sync_error: safeErrorMessage(error),
        });
      }
      return;
    case 'terminating':
      await terminate(workspace, config);
      return;
  }
};

let running = false;
let lastOrphanSweepAt = 0;

const reconcileManagedOrphans = async (config: RunPodComfyConfig): Promise<void> => {
  if (Date.now() - lastOrphanSweepAt < ORPHAN_SWEEP_MS) return;
  lastOrphanSweepAt = Date.now();
  const client = new ComfyPodClient(config);
  const pods = (await client.list()).filter(pod => pod.name.startsWith('aitk-comfy-'));
  for (const pod of pods) {
    const workspaceId = remoteWorkspaceId(pod);
    if (!workspaceId || pod.name !== `aitk-comfy-${workspaceId}`) {
      console.error(
        JSON.stringify({
          service: 'comfy-workspace',
          event: 'unmanaged_name_collision',
          podId: pod.id,
          name: pod.name,
        }),
      );
      continue;
    }
    const workspace = await prisma.comfyWorkspace.findUnique({ where: { id: workspaceId } });
    const expectedActive =
      workspace &&
      ACTIVE_STATES.includes(workspace.state) &&
      workspace.managed_pod_name === pod.name &&
      (!workspace.provider_pod_id || workspace.provider_pod_id === pod.id);
    if (expectedActive) continue;
    console.error(
      JSON.stringify({
        service: 'comfy-workspace',
        event: 'managed_orphan_delete',
        workspaceId,
        podId: pod.id,
        name: pod.name,
      }),
    );
    await client.delete(pod.id);
  }
};

export const reconcileComfyWorkspaces = async (): Promise<void> => {
  if (running) return;
  running = true;
  try {
    const config = await getRunPodComfyConfig();
    const activeCount = await prisma.comfyWorkspace.count({ where: { state: { in: ACTIVE_STATES } } });
    if (!config.apiKey) {
      if (activeCount) {
        console.error(
          JSON.stringify({
            service: 'comfy-workspace',
            event: 'disabled_with_active_workspace',
            reason: 'RUNPOD_API_KEY missing',
          }),
        );
      }
      return;
    }
    try {
      await reconcileManagedOrphans(config);
    } catch (error) {
      console.error(
        JSON.stringify({
          service: 'comfy-workspace',
          event: 'orphan_sweep_failed',
          message: safeErrorMessage(error),
        }),
      );
    }
    if (!activeCount) return;
    const errors = validateRunPodComfyConfig(config);
    const operationalErrors = errors.filter(error => !error.includes('disabled'));
    if (operationalErrors.length) {
      console.error(
        JSON.stringify({ service: 'comfy-workspace', event: 'configuration_invalid', errors: operationalErrors }),
      );
      return;
    }
    const now = new Date();
    const workspace = await prisma.comfyWorkspace.findFirst({
      where: {
        state: { in: ACTIVE_STATES },
        OR: [{ lease_owner: OWNER }, { lease_expires_at: null }, { lease_expires_at: { lt: now } }],
      },
      include: { job: true },
      orderBy: { created_at: 'asc' },
    });
    if (!workspace) return;
    const claimed = await prisma.comfyWorkspace.updateMany({
      where: {
        id: workspace.id,
        OR: [{ lease_owner: OWNER }, { lease_expires_at: null }, { lease_expires_at: { lt: now } }],
      },
      data: { lease_owner: OWNER, lease_expires_at: new Date(Date.now() + LEASE_MS) },
    });
    if (!claimed.count) return;
    let leaseLost = false;
    let renewalRunning = false;
    const renewal = setInterval(
      () => {
        if (renewalRunning) return;
        renewalRunning = true;
        void prisma.comfyWorkspace
          .updateMany({
            where: { id: workspace.id, lease_owner: OWNER, state: { in: ACTIVE_STATES } },
            data: { lease_expires_at: new Date(Date.now() + LEASE_MS) },
          })
          .then(result => {
            if (!result.count) leaseLost = true;
          })
          .catch(error => {
            leaseLost = true;
            log(workspace, 'lease_renewal_failed', { message: safeErrorMessage(error) });
          })
          .finally(() => {
            renewalRunning = false;
          });
      },
      Math.floor(LEASE_MS / 3),
    );
    try {
      log(workspace, 'advance');
      await advance(workspace, config);
      if (leaseLost) log(workspace, 'lease_lost');
    } catch (error) {
      const message = safeErrorMessage(error);
      const code =
        error instanceof ComfyBundleError
          ? error.code
          : error instanceof ComfyPodClientError
            ? error.code
            : error instanceof ComfySftpError
              ? error.code
              : error instanceof ComfyControlError
                ? error.code
                : 'WORKSPACE_RECONCILE_FAILED';
      log(workspace, 'advance_failed', { code, message });
      const retryable =
        (error instanceof ComfySftpError && error.retryable) ||
        (error instanceof ComfyControlError &&
          ['REMOTE_STATUS_UNAVAILABLE', 'REMOTE_STATUS_FAILED'].includes(error.code)) ||
        (error instanceof ComfyPodClientError && ['POD_UNAVAILABLE', 'POD_RATE_LIMITED'].includes(error.code));
      const transferAttempts =
        error instanceof ComfySftpError
          ? await prisma.comfyWorkspaceArtifact.aggregate({
              where: { workspace_id: workspace.id },
              _max: { attempts: true },
            })
          : null;
      if (retryable && (transferAttempts?._max.attempts || 0) < 5) {
        await update(workspace, {
          phase: `retrying_${code.toLowerCase()}`,
          error_code: code,
          error_message: message,
        });
      } else if (!workspace.provider_pod_id) {
        await failAbsent(workspace, code, message);
      } else {
        await update(workspace, {
          state: 'terminating',
          phase: 'failure_cleanup',
          error_code: code,
          error_message: message,
          termination_reason: 'failure',
          termination_requested_at: new Date(),
          termination_mode: 'immediate',
        });
      }
    } finally {
      clearInterval(renewal);
    }
  } finally {
    running = false;
  }
};
