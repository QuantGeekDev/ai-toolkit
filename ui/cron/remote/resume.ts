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

export const expectedCheckpointStep = (progressStep: number, saveEvery: number): number => {
  if (!Number.isSafeInteger(progressStep) || progressStep < 1) return 0;
  if (!Number.isSafeInteger(saveEvery) || saveEvery < 1) return 0;
  return Math.floor(progressStep / saveEvery) * saveEvery;
};
