import { describe, expect, it } from 'vitest';
import { validateRunPodConfig, type RunPodConfig } from './settings';

const validConfig: RunPodConfig = {
  enabled: true,
  apiKey: 'test-only',
  endpointId: 'endpoint-1',
  networkVolumeId: 'volume-1',
  s3Endpoint: 'https://s3api-eu-ro-1.runpod.io',
  s3Region: 'EU-RO-1',
  s3Bucket: 'volume-1',
  s3AccessId: 'access',
  s3Secret: 'secret',
  workerImageDigest: `example/image@sha256:${'a'.repeat(64)}`,
  maxConcurrentJobs: 3,
  executionTimeoutMs: 10_000,
  ttlMs: 20_000,
  bundleDirectory: 'C:\\bundles',
  apiBaseUrl: 'https://api.invalid/v2',
  restBaseUrl: 'https://rest.invalid/v1',
};

describe('RunPod settings', () => {
  it('accepts concurrency limits from one through three', () => {
    for (const maxConcurrentJobs of [1, 2, 3]) {
      expect(validateRunPodConfig({ ...validConfig, maxConcurrentJobs })).toEqual([]);
    }
  });

  it('rejects concurrency outside the cost safety ceiling', () => {
    for (const maxConcurrentJobs of [0, 4, 1.5, Number.NaN]) {
      expect(validateRunPodConfig({ ...validConfig, maxConcurrentJobs }).join(' ')).toContain(
        'RUNPOD_MAX_CONCURRENT_JOBS must be an integer from 1 to 3.',
      );
    }
  });
});
