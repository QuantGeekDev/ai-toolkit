import { describe, expect, it, vi } from 'vitest';
import { ArtifactStore } from './artifactStore';
import type { RunPodConfig } from './settings';

const config: RunPodConfig = {
  enabled: true,
  apiKey: 'unused',
  endpointId: 'endpoint',
  networkVolumeId: 'volume',
  s3Endpoint: 'https://s3.invalid',
  s3Region: 'EU-RO-1',
  s3Bucket: 'volume',
  s3AccessId: 'access',
  s3Secret: 'secret',
  workerImageDigest: `image@sha256:${'a'.repeat(64)}`,
  executionTimeoutMs: 1,
  ttlMs: 2,
  bundleDirectory: 'C:/bundles',
  apiBaseUrl: 'https://api.invalid',
  restBaseUrl: 'https://rest.invalid',
};

describe('RunPod volume artifact store', () => {
  it('rejects traversal before issuing an S3 request', async () => {
    const client = { send: vi.fn() } as any;
    const store = new ArtifactStore(config, client);
    await expect(store.getJson('../secret')).rejects.toThrow('Unsafe object key');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('reads JSON and returns null for missing objects', async () => {
    const client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Body: { transformToByteArray: async () => Buffer.from('{"ok":true}') },
          ContentLength: 11,
        })
        .mockRejectedValueOnce({ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }),
    } as any;
    const store = new ArtifactStore(config, client);
    await expect(store.getJson('aitk/state.json')).resolves.toEqual({ ok: true });
    await expect(store.getJson('aitk/missing.json')).resolves.toBeNull();
  });

  it('paginates prefix listings without trusting ETags as hashes', async () => {
    const client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          IsTruncated: true,
          NextContinuationToken: 'next',
          Contents: [{ Key: 'aitk/runs/a', Size: 1, ETag: '"etag-a"' }],
        })
        .mockResolvedValueOnce({
          IsTruncated: false,
          Contents: [{ Key: 'aitk/runs/b', Size: 2, ETag: '"etag-b"' }],
        }),
    } as any;
    const store = new ArtifactStore(config, client);
    await expect(store.list('aitk/runs')).resolves.toEqual([
      { key: 'aitk/runs/a', size: 1, etag: 'etag-a', modifiedAt: undefined },
      { key: 'aitk/runs/b', size: 2, etag: 'etag-b', modifiedAt: undefined },
    ]);
  });

  it('accepts the portable ready sidecar when custom metadata is absent', async () => {
    const sha256 = 'b'.repeat(64);
    const client = {
      send: vi
        .fn()
        .mockResolvedValueOnce({ ContentLength: 123, Metadata: {} })
        .mockResolvedValueOnce({
          Body: {
            transformToByteArray: async () =>
              Buffer.from(JSON.stringify({ schemaVersion: 1, sha256, bytes: 123 }), 'utf8'),
          },
        }),
    } as any;
    const store = new ArtifactStore(config, client);
    await expect(
      store.putImmutableFile('aitk/bundles/bundle.tar.gz', 'not-read-for-existing', sha256),
    ).resolves.toMatchObject({
      size: 123,
      sha256,
    });
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('fails a repeated continuation token instead of looping forever', async () => {
    const client = {
      send: vi.fn().mockResolvedValue({ IsTruncated: true, NextContinuationToken: 'same', Contents: [] }),
    } as any;
    const store = new ArtifactStore(config, client);
    await expect(store.list('aitk/runs')).rejects.toThrow('repeated continuation token');
    expect(client.send).toHaveBeenCalledTimes(2);
  });
});
