import { createReadStream, createWriteStream, promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { RunPodConfig } from './settings';

export type StoredObject = {
  key: string;
  size: number;
  etag?: string;
  sha256?: string;
  modifiedAt?: Date;
};

// RunPod documents PutObject for files below 500 MB. Keeping small bundles on
// that path also avoids creating a multipart upload before the filesystem-like
// parent path exists on a new network volume.
const RUNPOD_SINGLE_PUT_MAX_BYTES = 500_000_000;

const normalizeKey = (key: string): string => {
  const normalized = key.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe object key: ${key}`);
  }
  return normalized;
};

const isMissing = (error: any): boolean =>
  error?.name === 'NotFound' || error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404;

const isRunPodFilesystemMissing = (error: any): boolean =>
  error?.message === 'Invalid object path' ||
  (error?.name === 'Unknown' && error?.message === 'UnknownError' && error?.$metadata?.httpStatusCode === 403);

const rawSuccessAfterInvalidHttpDate = (error: any): any | null => {
  const status = Number(error?.$response?.statusCode || error?.$metadata?.httpStatusCode || 0);
  return status >= 200 && status < 300 && /Invalid RFC7231 date-time value/i.test(String(error?.message || ''))
    ? error.$response
    : null;
};

const rawHeader = (response: any, name: string): string | undefined => {
  const value = response?.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
};

const compatibleHttpDate = (value: string | undefined): Date | undefined => {
  if (!value) return undefined;
  // RunPod currently emits RFC7231-shaped Last-Modified headers ending in
  // "UTC". RFC7231 requires "GMT", and the JS AWS SDK rejects the former.
  const parsed = new Date(value.replace(/ UTC$/i, ' GMT'));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

const readBody = async (body: any): Promise<Buffer> => {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

export class ArtifactStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly isRunPodStorage: boolean;

  constructor(config: RunPodConfig, client?: S3Client) {
    this.bucket = config.s3Bucket;
    try {
      this.isRunPodStorage = /^s3api-.+\.runpod\.io$/i.test(new URL(config.s3Endpoint).hostname);
    } catch {
      this.isRunPodStorage = false;
    }
    this.client =
      client ||
      new S3Client({
        endpoint: config.s3Endpoint,
        region: config.s3Region,
        forcePathStyle: true,
        credentials: { accessKeyId: config.s3AccessId, secretAccessKey: config.s3Secret },
      });
  }

  async head(key: string): Promise<StoredObject | null> {
    key = normalizeKey(key);
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        key,
        size: Number(result.ContentLength || 0),
        etag: result.ETag?.replace(/"/g, ''),
        sha256: result.Metadata?.sha256,
        modifiedAt: result.LastModified,
      };
    } catch (error) {
      const rawResponse = rawSuccessAfterInvalidHttpDate(error);
      if (rawResponse) {
        return {
          key,
          size: Number(rawHeader(rawResponse, 'content-length') || 0),
          etag: rawHeader(rawResponse, 'etag')?.replace(/"/g, ''),
          sha256: rawHeader(rawResponse, 'x-amz-meta-sha256'),
          modifiedAt: compatibleHttpDate(rawHeader(rawResponse, 'last-modified')),
        };
      }
      if (isMissing(error) || (this.isRunPodStorage && isRunPodFilesystemMissing(error))) return null;
      throw error;
    }
  }

  async putImmutableFile(key: string, filePath: string, sha256: string): Promise<StoredObject> {
    key = normalizeKey(key);
    const readyKey = `${key}.aitk-ready.json`;
    const verifiedExisting = async (existing: StoredObject, expectedSize?: number): Promise<StoredObject | null> => {
      if (expectedSize !== undefined && existing.size !== expectedSize) return null;
      if (existing.sha256 === sha256) return existing;
      if (existing.sha256) return null;
      const marker = await this.getJson<{ schemaVersion?: number; sha256?: string; bytes?: number }>(readyKey);
      if (
        marker?.schemaVersion === 1 &&
        marker.sha256 === sha256 &&
        Number(marker.bytes) === existing.size &&
        (expectedSize === undefined || Number(marker.bytes) === expectedSize)
      ) {
        return { ...existing, sha256 };
      }
      return null;
    };
    const existing = await this.head(key);
    if (existing) {
      const verified = await verifiedExisting(existing);
      if (verified) return verified;
      throw new Error(`Immutable object collision at ${key}`);
    }
    const stats = await fs.stat(filePath);
    const uploadParams = {
      Bucket: this.bucket,
      Key: key,
      Body: createReadStream(filePath),
      ContentLength: stats.size,
      ContentType: 'application/gzip',
      Metadata: { sha256 },
    };
    if (stats.size < RUNPOD_SINGLE_PUT_MAX_BYTES) {
      await this.client.send(new PutObjectCommand(uploadParams));
    } else {
      const upload = new Upload({
        client: this.client,
        params: uploadParams,
        queueSize: 2,
        partSize: 16 * 1024 * 1024,
        leavePartsOnError: false,
      });
      await upload.done();
    }
    // RunPod implements HeadObject, but user-defined metadata behavior can
    // differ across S3-compatible backends. A sidecar is the portable ready
    // marker; the worker still hashes the archive itself before using it.
    await this.putJson(readyKey, { schemaVersion: 1, sha256, bytes: stats.size });
    const stored = await this.head(key);
    const verified = stored ? await verifiedExisting(stored, stats.size) : null;
    if (!verified) {
      throw new Error(`Object verification failed after uploading ${key}`);
    }
    return verified;
  }

  async putJson(key: string, value: unknown): Promise<void> {
    key = normalizeKey(key);
    const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: 'application/json',
        CacheControl: 'no-store',
      }),
    );
  }

  async getBuffer(key: string, range?: string): Promise<{ body: Buffer; size?: number; contentRange?: string } | null> {
    key = normalizeKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(range ? { Range: range } : {}) }),
      );
      return { body: await readBody(result.Body), size: result.ContentLength, contentRange: result.ContentRange };
    } catch (error) {
      const rawResponse = rawSuccessAfterInvalidHttpDate(error);
      if (rawResponse) {
        return {
          body: await readBody(rawResponse.body),
          size: Number(rawHeader(rawResponse, 'content-length') || 0),
          contentRange: rawHeader(rawResponse, 'content-range'),
        };
      }
      if (isMissing(error) || (this.isRunPodStorage && isRunPodFilesystemMissing(error))) return null;
      throw error;
    }
  }

  async getJson<T>(key: string): Promise<T | null> {
    const result = await this.getBuffer(key);
    if (!result) return null;
    return JSON.parse(result.body.toString('utf8')) as T;
  }

  async downloadFile(key: string, destination: string, expectedSha256?: string): Promise<boolean> {
    key = normalizeKey(key);
    let result: any;
    try {
      result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      const rawResponse = rawSuccessAfterInvalidHttpDate(error);
      if (rawResponse) result = { Body: rawResponse.body };
      else {
        if (isMissing(error) || (this.isRunPodStorage && isRunPodFilesystemMissing(error))) return false;
        throw error;
      }
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.part-${process.pid}`;
    const digest = createHash('sha256');
    const stream = createWriteStream(temporary, { flags: 'wx' });
    let streamFailure: Error | null = null;
    stream.on('error', error => {
      streamFailure = error;
    });
    const waitFor = (event: 'drain' | 'finish') =>
      new Promise<void>((resolve, reject) => {
        if (streamFailure) {
          reject(streamFailure);
          return;
        }
        const cleanup = () => {
          stream.off(event, onEvent);
          stream.off('error', onError);
        };
        const onEvent = () => {
          cleanup();
          resolve();
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        stream.once(event, onEvent);
        stream.once('error', onError);
      });
    try {
      for await (const chunk of result.Body as AsyncIterable<Uint8Array | string>) {
        const buffer = Buffer.from(chunk);
        digest.update(buffer);
        if (!stream.write(buffer)) await waitFor('drain');
      }
      stream.end();
      await waitFor('finish');
    } catch (error) {
      stream.destroy();
      await fs.rm(temporary, { force: true });
      throw error;
    }
    const actualSha256 = digest.digest('hex');
    if (expectedSha256 && actualSha256 !== expectedSha256) {
      await fs.rm(temporary, { force: true });
      throw new Error(`SHA-256 mismatch while downloading ${key}`);
    }
    const previous = `${destination}.previous-${process.pid}`;
    let hadPrevious = false;
    try {
      await fs.rename(destination, previous);
      hadPrevious = true;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await fs.rename(temporary, destination);
      if (hadPrevious) await fs.rm(previous, { force: true });
    } catch (error) {
      if (hadPrevious) await fs.rename(previous, destination).catch(() => undefined);
      await fs.rm(temporary, { force: true });
      throw error;
    }
    return true;
  }

  async list(prefix: string): Promise<StoredObject[]> {
    prefix = normalizeKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix) + '/';
    const objects: StoredObject[] = [];
    let continuationToken: string | undefined;
    const seenTokens = new Set<string>();
    do {
      let result: any;
      try {
        result = await this.client.send(
          new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: continuationToken }),
        );
      } catch (error) {
        // RunPod maps object keys to real filesystem paths and reports a
        // missing directory as "Invalid object path" (or a generic 403)
        // instead of returning an empty S3 listing.
        if (isMissing(error) || (this.isRunPodStorage && isRunPodFilesystemMissing(error))) return objects;
        throw error;
      }
      for (const item of result.Contents || []) {
        if (!item.Key) continue;
        objects.push({
          key: item.Key,
          size: Number(item.Size || 0),
          etag: item.ETag?.replace(/"/g, ''),
          modifiedAt: item.LastModified,
        });
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
      if (continuationToken) {
        if (seenTokens.has(continuationToken)) {
          throw new Error(
            'RunPod S3 returned a repeated continuation token; retry the listing after its index settles.',
          );
        }
        seenTokens.add(continuationToken);
      }
      if (objects.length > 100_000) throw new Error('Object listing exceeds the safety limit.');
    } while (continuationToken);
    return objects;
  }
}
