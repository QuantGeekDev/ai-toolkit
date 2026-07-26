import { describe, expect, it } from 'vitest';
import {
  isInterruptedRemoteResumeCandidate,
  isRemoteResumeCandidate,
  expectedCheckpointStep,
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

  it('derives the last checkpoint expected from progress and save cadence', () => {
    expect(expectedCheckpointStep(7563, 250)).toBe(7500);
    expect(expectedCheckpointStep(249, 250)).toBe(0);
    expect(expectedCheckpointStep(7563, 0)).toBe(0);
  });
});
