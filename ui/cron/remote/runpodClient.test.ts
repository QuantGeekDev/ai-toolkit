import { describe, expect, it, vi } from 'vitest';
import { RunPodClient, RunPodClientError } from './runpodClient';
import type { RunPodConfig } from './settings';

const config: RunPodConfig = {
  enabled: true,
  apiKey: 'test-only',
  endpointId: 'endpoint-1',
  networkVolumeId: 'volume-1',
  s3Endpoint: 'https://s3.invalid',
  s3Region: 'EU-RO-1',
  s3Bucket: 'volume-1',
  s3AccessId: 'access',
  s3Secret: 'secret',
  workerImageDigest: `example/image@sha256:${'a'.repeat(64)}`,
  executionTimeoutMs: 10_000,
  ttlMs: 20_000,
  bundleDirectory: 'bundles',
  apiBaseUrl: 'https://api.invalid/v2',
  restBaseUrl: 'https://rest.invalid/v1',
};

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('RunPod client', () => {
  it('does not blindly retry ambiguous POST submissions', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket reset')) as any;
    const client = new RunPodClient(
      config,
      fetchMock,
      async () => undefined,
      () => 0,
    );
    await expect(client.submit({ requestKey: 'stable' })).rejects.toMatchObject({
      code: 'REMOTE_SUBMISSION_UNKNOWN',
      ambiguous: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries safe status reads and succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ error: 'busy' }, 503))
      .mockResolvedValueOnce(response({ id: 'job-1', status: 'IN_PROGRESS' })) as any;
    const client = new RunPodClient(
      config,
      fetchMock,
      async () => undefined,
      () => 0,
    );
    await expect(client.status('job-1')).resolves.toMatchObject({ status: 'IN_PROGRESS' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('enforces scale-to-zero, one H100, volume, and immutable image during preflight', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          {
            id: 'endpoint-1',
            workersMin: 0,
            workersMax: 1,
            gpuCount: 1,
            idleTimeout: 5,
            computeType: 'GPU',
            networkVolumeId: 'volume-1',
            dataCenterIds: ['EU-RO-1'],
            gpuTypeIds: ['NVIDIA H100 80GB HBM3'],
            workers: [],
            template: { image: config.workerImageDigest, env: { AITK_WORKER_IMAGE_DIGEST: config.workerImageDigest } },
          },
        ]),
      )
      .mockResolvedValueOnce(response({ workers: { idle: 0, running: 0 } })) as any;
    const client = new RunPodClient(
      config,
      fetchMock,
      async () => undefined,
      () => 0,
    );
    await expect(client.preflight()).resolves.toMatchObject({ ok: true, errors: [] });
  });

  it('accepts the API v2 singular GPU, root image, volume array, and environment array shape', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          {
            id: 'endpoint-1',
            workersMin: 0,
            workersMax: 1,
            gpuCount: 1,
            idleTimeout: 5,
            computeType: 'GPU',
            networkVolumeIds: ['volume-1'],
            dataCenterId: 'EU-RO-1',
            gpuTypeId: 'NVIDIA H100 80GB HBM3',
            workers: [],
            image: config.workerImageDigest,
            env: [{ key: 'AITK_WORKER_IMAGE_DIGEST', value: config.workerImageDigest }],
          },
        ]),
      )
      .mockResolvedValueOnce(response({ workers: { idle: 0, running: 0 } })) as any;
    const result = await new RunPodClient(
      config,
      fetchMock,
      async () => undefined,
      () => 0,
    ).preflight();
    expect(result).toMatchObject({ ok: true, errors: [], warnings: [] });
  });

  it('blocks active workers, GPU fallbacks, and a wrong datacenter', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          {
            id: 'endpoint-1',
            workersMin: 0,
            workersMax: 1,
            gpuCount: 1,
            idleTimeout: 5,
            computeType: 'GPU',
            networkVolumeId: 'volume-1',
            dataCenterIds: ['US-CA-2'],
            gpuTypeIds: ['NVIDIA H100 80GB HBM3', 'NVIDIA H200'],
            workers: [{ id: 'worker-1' }],
            template: { image: config.workerImageDigest },
          },
        ]),
      )
      .mockResolvedValueOnce(response({ workers: { idle: 0, running: 1 } })) as any;
    const result = await new RunPodClient(
      config,
      fetchMock,
      async () => undefined,
      () => 0,
    ).preflight();
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('GPU fallbacks');
    expect(result.errors.join(' ')).toContain('active worker');
    expect(result.errors.join(' ')).toContain('datacenters');
  });

  it('ignores terminated worker records when health reports scale-to-zero', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          {
            id: 'endpoint-1',
            workersMin: 0,
            workersMax: 1,
            gpuCount: 1,
            idleTimeout: 5,
            computeType: 'GPU',
            networkVolumeId: 'volume-1',
            dataCenterIds: ['EU-RO-1'],
            gpuTypeIds: ['NVIDIA H100 80GB HBM3'],
            workers: [{ id: 'terminated-worker-with-stale-rest-record' }],
            template: { image: config.workerImageDigest, env: { AITK_WORKER_IMAGE_DIGEST: config.workerImageDigest } },
          },
        ]),
      )
      .mockResolvedValueOnce(
        response({
          workers: { idle: 0, initializing: 0, ready: 0, running: 0, throttled: 1, unhealthy: 0 },
        }),
      ) as any;
    const result = await new RunPodClient(
      config,
      fetchMock,
      async () => undefined,
      () => 0,
    ).preflight();
    expect(result).toMatchObject({ ok: true, errors: [] });
  });

  it('does not double-count a worker reported as both idle and ready', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          {
            id: 'endpoint-1',
            workersMin: 0,
            workersMax: 1,
            gpuCount: 1,
            idleTimeout: 5,
            computeType: 'GPU',
            networkVolumeId: 'volume-1',
            dataCenterIds: ['EU-RO-1'],
            gpuTypeIds: ['NVIDIA H100 80GB HBM3'],
            workers: [{ id: 'worker-1' }],
            template: { image: config.workerImageDigest, env: { AITK_WORKER_IMAGE_DIGEST: config.workerImageDigest } },
          },
        ]),
      )
      .mockResolvedValueOnce(
        response({ workers: { idle: 1, initializing: 0, ready: 1, running: 0, unhealthy: 0 } }),
      ) as any;
    const result = await new RunPodClient(
      config,
      fetchMock,
      async () => undefined,
      () => 0,
    ).preflight();
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('1 active worker');
    expect(result.errors.join(' ')).not.toContain('2 active workers');
  });

  it('falls back to endpoint worker records when health omits worker counts', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          {
            id: 'endpoint-1',
            workersMin: 0,
            workersMax: 1,
            gpuCount: 1,
            idleTimeout: 5,
            computeType: 'GPU',
            networkVolumeId: 'volume-1',
            dataCenterIds: ['EU-RO-1'],
            gpuTypeIds: ['NVIDIA H100 80GB HBM3'],
            workers: [{ id: 'worker-1' }],
            template: { image: config.workerImageDigest, env: { AITK_WORKER_IMAGE_DIGEST: config.workerImageDigest } },
          },
        ]),
      )
      .mockResolvedValueOnce(response({ workers: {} })) as any;
    const result = await new RunPodClient(
      config,
      fetchMock,
      async () => undefined,
      () => 0,
    ).preflight();
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('1 active worker');
  });

  it('maps authentication failures without exposing response credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ error: `bad rpa_${'z'.repeat(32)}` }, 401)) as any;
    const client = new RunPodClient(
      config,
      fetchMock,
      async () => undefined,
      () => 0,
    );
    await expect(client.status('job-1')).rejects.toSatisfy((error: RunPodClientError) => {
      expect(error.code).toBe('REMOTE_AUTH_FAILED');
      expect(error.message).not.toContain('rpa_');
      return true;
    });
  });
});
