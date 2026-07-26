export type RemoteResumeCandidate = {
  state: string;
  artifact_sync_state: string;
  error_code: string | null;
  provider_job_id: string | null;
  progress_json: string;
  bundle_content_digest: string;
  bundle_archive_sha256: string;
  bundle_object_key: string | null;
  run_prefix: string;
};

const SHA256 = /^[0-9a-f]{64}$/i;
const CONTENT_DIGEST = /^sha256:[0-9a-f]{64}$/i;

export const remoteProgressStep = (execution: Pick<RemoteResumeCandidate, 'progress_json'>): number => {
  try {
    const step = Number(JSON.parse(execution.progress_json || '{}')?.step);
    return Number.isSafeInteger(step) && step > 0 ? step : 0;
  } catch {
    return 0;
  }
};

export const isInterruptedRemoteResumeCandidate = (execution: RemoteResumeCandidate): boolean =>
  execution.state === 'error' &&
  execution.error_code === 'RUNPOD_FAILED' &&
  Boolean(execution.provider_job_id) &&
  Boolean(execution.bundle_object_key) &&
  CONTENT_DIGEST.test(execution.bundle_content_digest) &&
  SHA256.test(execution.bundle_archive_sha256) &&
  remoteProgressStep(execution) > 0;

export const isRemoteResumeCandidate = (execution: RemoteResumeCandidate): boolean =>
  (['completed', 'stopped'].includes(execution.state) && execution.artifact_sync_state === 'complete') ||
  isInterruptedRemoteResumeCandidate(execution);

export const latestCheckpointStep = (
  objects: Array<{ key: string; size: number }>,
  jobName: string,
): number => {
  const escapedName = jobName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const checkpoint = new RegExp(`(?:^|/)${escapedName}_(\\d{9})\\.safetensors$`, 'i');
  let latest = 0;
  for (const object of objects) {
    if (object.size <= 0) continue;
    const match = checkpoint.exec(object.key);
    if (match) latest = Math.max(latest, Number(match[1]));
  }
  return latest;
};
