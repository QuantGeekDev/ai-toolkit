import { describe, expect, it } from 'vitest';
import {
  isInterruptedRemoteResumeCandidate,
  isRemoteResumeCandidate,
  latestCheckpointStep,
  remoteProgressStep,
  type RemoteResumeCandidate,
} from './resume';

const execution = (overrides: Partial<RemoteResumeCandidate> = {}): RemoteResumeCandidate => ({
  state: 'error',
  artifact_sync_state: 'pending',
  error_code: 'RUNPOD_FAILED',
  provider_job_id: 'provider-job',
  progress_json: JSON.stringify({ step: 7563, totalSteps: 8000 }),
  bundle_content_digest: `sha256:${'a'.repeat(64)}`,
  bundle_archive_sha256: 'b'.repeat(64),
  bundle_object_key: 'aitk/bundles/example.tar.gz',
  run_prefix: 'runs/execution-id',
  ...overrides,
});

describe('remote resume recovery', () => {
  it('accepts an interrupted provider run only when it has progress and immutable bundle identity', () => {
    expect(isInterruptedRemoteResumeCandidate(execution())).toBe(true);
    expect(isInterruptedRemoteResumeCandidate(execution({ progress_json: '{"step":0}' }))).toBe(false);
    expect(isInterruptedRemoteResumeCandidate(execution({ error_code: 'TRAINING_FAILED' }))).toBe(false);
    expect(isInterruptedRemoteResumeCandidate(execution({ bundle_object_key: null }))).toBe(false);
  });

  it('continues to accept fully synchronized completed and stopped attempts', () => {
    expect(isRemoteResumeCandidate(execution({ state: 'completed', artifact_sync_state: 'complete' }))).toBe(true);
    expect(isRemoteResumeCandidate(execution({ state: 'stopped', artifact_sync_state: 'complete' }))).toBe(true);
    expect(isRemoteResumeCandidate(execution({ state: 'stopped', artifact_sync_state: 'partial' }))).toBe(false);
  });

  it('parses progress defensively', () => {
    expect(remoteProgressStep(execution())).toBe(7563);
    expect(remoteProgressStep(execution({ progress_json: 'not-json' }))).toBe(0);
    expect(remoteProgressStep(execution({ progress_json: '{"step":1.5}' }))).toBe(0);
  });

  it('selects the latest complete non-empty checkpoint for the exact job name', () => {
    expect(
      latestCheckpointStep(
        [
          { key: 'aitk/runs/x/output/analogv3/analogv3_000007250.safetensors', size: 10 },
          { key: 'aitk/runs/x/output/analogv3/analogv3_000007500.safetensors', size: 10 },
          { key: 'aitk/runs/x/output/analogv3/analogv3_000007750.safetensors', size: 0 },
          { key: 'aitk/runs/x/output/other_000009000.safetensors', size: 10 },
        ],
        'analogv3',
      ),
    ).toBe(7500);
  });
});
