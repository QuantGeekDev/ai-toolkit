import { createReadStream, promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Job, RemoteExecution } from '@prisma/client';
import { AwsArchiveConfig } from './settings';

const safeKey = (value: string): string => {
  const key = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!key || key.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error('Unsafe AWS archive key.');
  return key;
};

const hashFile = async (file: string): Promise<{ sha256: string; bytes: number }> => {
  const digest = createHash('sha256');
  let bytes = 0;
  const stream = createReadStream(file);
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    digest.update(buffer);
    bytes += buffer.length;
  }
  return { sha256: digest.digest('hex'), bytes };
};

export class AwsArchiveStore {
  private readonly client: S3Client;

  constructor(
    private readonly config: AwsArchiveConfig,
    client?: S3Client,
  ) {
    this.client = client || new S3Client({ region: config.region });
  }

  async putFile(key: string, file: string, expectedSha256?: string): Promise<void> {
    key = safeKey(key);
    const identity = await hashFile(file);
    if (expectedSha256 && identity.sha256 !== expectedSha256)
      throw new Error(`Local archive source checksum mismatch: ${file}`);
    try {
      const existing = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      if (existing.Metadata?.sha256 === identity.sha256 && Number(existing.ContentLength) === identity.bytes) return;
      throw new Error(`Immutable AWS archive collision at ${key}`);
    } catch (error: any) {
      if (!['NotFound', 'NoSuchKey'].includes(error?.name) && error?.$metadata?.httpStatusCode !== 404) throw error;
    }
    await new Upload({
      client: this.client,
      params: {
        Bucket: this.config.bucket,
        Key: key,
        Body: createReadStream(file),
        ContentLength: identity.bytes,
        Metadata: { sha256: identity.sha256 },
        ServerSideEncryption: 'AES256',
      },
      partSize: 16 * 1024 * 1024,
      queueSize: 2,
      leavePartsOnError: false,
    }).done();
    const stored = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
    if (stored.Metadata?.sha256 !== identity.sha256 || Number(stored.ContentLength) !== identity.bytes) {
      throw new Error(`AWS archive verification failed for ${key}`);
    }
  }

  async putJson(key: string, value: unknown): Promise<void> {
    key = safeKey(key);
    const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    const sha256 = createHash('sha256').update(body).digest('hex');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: 'application/json',
        Metadata: { sha256 },
        ServerSideEncryption: 'AES256',
      }),
    );
  }
}

export const archiveRemoteExecution = async (
  config: AwsArchiveConfig,
  execution: RemoteExecution,
  job: Job,
  outputDirectory: string,
): Promise<string> => {
  if (!config.enabled) throw new Error('AWS archive is disabled.');
  if (!config.bucket) throw new Error('AWS_ARCHIVE_BUCKET is not configured.');
  const store = new AwsArchiveStore(config);
  const prefix = safeKey(`${config.prefix}/runs/${execution.id}`);
  if (!execution.bundle_local_path || !execution.bundle_archive_sha256)
    throw new Error('Local immutable bundle is unavailable.');
  await store.putFile(
    `${config.prefix}/bundles/${execution.bundle_content_digest.replace(/^sha256:/, '')}/${execution.bundle_archive_sha256}.tar.gz`,
    execution.bundle_local_path,
    execution.bundle_archive_sha256,
  );
  const recordPath = path.join(outputDirectory, '.remote-execution.json');
  const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  for (const artifact of record.artifacts || []) {
    const relative = String(artifact.path || '').replace(/\\/g, '/');
    if (!relative || relative.split('/').some((part: string) => !part || part === '.' || part === '..')) {
      throw new Error(`Unsafe local artifact path: ${relative}`);
    }
    await store.putFile(
      `${prefix}/artifacts/${relative}`,
      path.join(outputDirectory, ...relative.split('/')),
      artifact.sha256,
    );
  }
  await store.putJson(`${prefix}/archive.json`, {
    schemaVersion: 1,
    executionId: execution.id,
    jobId: job.id,
    jobName: job.name,
    bundleContentDigest: execution.bundle_content_digest,
    bundleArchiveSha256: execution.bundle_archive_sha256,
    workerImageDigest: execution.worker_image_digest,
    result: record.result,
    artifacts: record.artifacts,
    archivedAt: new Date().toISOString(),
  });
  return prefix;
};
