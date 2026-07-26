import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  maxConcurrentJobs: 3,
  executionTimeoutMs: 1,
  ttlMs: 2,
  bundleDirectory: 'C:/bundles',
  apiBaseUrl: 'https://api.invalid',
  restBaseUrl: 'https://rest.invalid',
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

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

  it('recovers HeadObject metadata from RunPod UTC Last-Modified headers', async () => {
    const error: any = new TypeError('Invalid RFC7231 date-time value Sun, 26 Jul 2026 19:06:35 UTC.');
    error.$metadata = { httpStatusCode: 200 };
    error.$response = {
      statusCode: 200,
      headers: {
        'content-length': '123',
        etag: '"etag"',
        'last-modified': 'Sun, 26 Jul 2026 19:06:35 UTC',
        'x-amz-meta-sha256': 'a'.repeat(64),
      },
    };
    const store = new ArtifactStore(config, { send: vi.fn().mockRejectedValue(error) } as any);
    await expect(store.head('aitk/bundle.tar.gz')).resolves.toEqual({
      key: 'aitk/bundle.tar.gz',
      size: 123,
      etag: 'etag',
      sha256: 'a'.repeat(64),
      modifiedAt: new Date('2026-07-26T19:06:35.000Z'),
    });
  });

  it('recovers GetObject bodies after RunPod UTC header deserialization failures', async () => {
    const error: any = new TypeError('Invalid RFC7231 date-time value Sun, 26 Jul 2026 19:06:35 UTC.');
    error.$metadata = { httpStatusCode: 200 };
    error.$response = {
      statusCode: 200,
      headers: { 'content-length': '11', 'last-modified': 'Sun, 26 Jul 2026 19:06:35 UTC' },
      body: { transformToByteArray: async () => Buffer.from('{"ok":true}') },
    };
    const store = new ArtifactStore(config, { send: vi.fn().mockRejectedValue(error) } as any);
    await expect(store.getJson('aitk/state.json')).resolves.toEqual({ ok: true });
  });

  it('treats RunPod filesystem-style missing paths as absent', async () => {
    const error: any = new Error('UnknownError');
    error.name = 'Unknown';
    error.$metadata = { httpStatusCode: 403 };
    const runPodConfig = { ...config, s3Endpoint: 'https://s3api-us-ca-2.runpod.io' };
    await expect(new ArtifactStore(runPodConfig, { send: vi.fn().mockRejectedValue(error) } as any).head('aitk/new/file'))
      .resolves.toBeNull();
    await expect(new ArtifactStore(config, { send: vi.fn().mockRejectedValue(error) } as any).head('aitk/new/file'))
      .rejects.toThrow('UnknownError');
  });

  it('uses PutObject rather than multipart upload for bundles below RunPod\'s 500 MB limit', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aitk-artifact-store-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'bundle.tar.gz');
    await fs.writeFile(filePath, 'small bundle');
    const sha256 = 'b'.repeat(64);
    const send = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('UnknownError'), {
        name: 'Unknown',
        $metadata: { httpStatusCode: 403 },
      }))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ ContentLength: 12, Metadata: { sha256 } });
    const runPodConfig = { ...config, s3Endpoint: 'https://s3api-us-ca-2.runpod.io' };
    await expect(new ArtifactStore(runPodConfig, { send } as any).putImmutableFile('aitk/new/bundle.tar.gz', filePath, sha256))
      .resolves.toMatchObject({ size: 12, sha256 });
    expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      'HeadObjectCommand',
      'PutObjectCommand',
      'PutObjectCommand',
      'HeadObjectCommand',
    ]);
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

  it('returns an empty listing for a missing RunPod filesystem prefix', async () => {
    const error: any = new Error('Invalid object path');
    error.$metadata = { httpStatusCode: 400 };
    const runPodConfig = { ...config, s3Endpoint: 'https://s3api-us-ca-2.runpod.io' };
    await expect(new ArtifactStore(runPodConfig, { send: vi.fn().mockRejectedValue(error) } as any).list('aitk/new-run'))
      .resolves.toEqual([]);
    await expect(new ArtifactStore(config, { send: vi.fn().mockRejectedValue(error) } as any).list('aitk/new-run'))
      .rejects.toThrow('Invalid object path');
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
