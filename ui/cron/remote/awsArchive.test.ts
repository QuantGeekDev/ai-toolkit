import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AwsArchiveStore, resolveContainedArtifact } from './awsArchive';
import type { AwsArchiveConfig } from './settings';

const config: AwsArchiveConfig = {
  enabled: true,
  bucket: 'archive-bucket',
  region: 'eu-west-1',
  prefix: 'ai-toolkit',
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

const jsonIdentity = (value: unknown) => {
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return { bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
};

describe('AWS archive store', () => {
  it('reuses an identical immutable JSON record', async () => {
    const identity = jsonIdentity({ result: 'complete' });
    const client = {
      send: vi.fn().mockResolvedValue({
        ContentLength: identity.bytes,
        Metadata: { sha256: identity.sha256 },
      }),
    } as any;
    const store = new AwsArchiveStore(config, client);

    await store.putJson('ai-toolkit/runs/id/archive.json', { result: 'complete' });

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
  });

  it('uses a conditional write and verifies a new JSON record', async () => {
    const identity = jsonIdentity({ ok: true });
    const client = {
      send: vi
        .fn()
        .mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ ContentLength: identity.bytes, Metadata: { sha256: identity.sha256 } }),
    } as any;
    const store = new AwsArchiveStore(config, client);

    await store.putJson('ai-toolkit/runs/id/archive.json', { ok: true });

    expect(client.send).toHaveBeenCalledTimes(3);
    const put = client.send.mock.calls[1][0];
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect(put.input).toMatchObject({ IfNoneMatch: '*', ServerSideEncryption: 'AES256' });
  });

  it('fails instead of overwriting a different immutable JSON record', async () => {
    const client = {
      send: vi.fn().mockResolvedValue({ ContentLength: 12, Metadata: { sha256: 'different' } }),
    } as any;
    const store = new AwsArchiveStore(config, client);

    await expect(store.putJson('ai-toolkit/runs/id/archive.json', { ok: true })).rejects.toThrow(
      'Immutable AWS archive collision',
    );
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('accepts a concurrent conditional writer only when its bytes match', async () => {
    const identity = jsonIdentity({ ok: true });
    const client = {
      send: vi
        .fn()
        .mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })
        .mockRejectedValueOnce({ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } })
        .mockResolvedValueOnce({ ContentLength: identity.bytes, Metadata: { sha256: identity.sha256 } }),
    } as any;
    const store = new AwsArchiveStore(config, client);

    await expect(store.putJson('ai-toolkit/runs/id/archive.json', { ok: true })).resolves.toBeUndefined();
    expect(client.send).toHaveBeenCalledTimes(3);
  });
});

describe('AWS archive artifact paths', () => {
  it('resolves a regular file inside the output directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aitk-archive-'));
    temporaryDirectories.push(root);
    await fs.mkdir(path.join(root, 'checkpoints'));
    const artifact = path.join(root, 'checkpoints', 'model.safetensors');
    await fs.writeFile(artifact, 'weights');

    await expect(resolveContainedArtifact(root, 'checkpoints/model.safetensors')).resolves.toBe(
      await fs.realpath(artifact),
    );
  });

  it('rejects traversal before touching a file outside the output directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aitk-archive-'));
    temporaryDirectories.push(root);

    await expect(resolveContainedArtifact(root, '../secret')).rejects.toThrow('Unsafe local artifact path');
  });
});
