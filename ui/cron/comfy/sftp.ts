import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Client, type SFTPWrapper } from 'ssh2';
import type { ComfyWorkspaceArtifact } from '@prisma/client';

export class ComfySftpError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

const normalizeFingerprint = (value: string) =>
  value
    .trim()
    .replace(/^SHA256:/i, '')
    .replace(/=+$/, '');
const fingerprint = (key: Buffer) => crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');

const safeRemotePath = (relative: string): string => {
  if (!relative || relative.includes('\\') || relative.startsWith('/') || relative.includes('\0')) {
    throw new ComfySftpError('SFTP_PATH_INVALID', 'Remote artifact path must be a relative POSIX path.');
  }
  const normalized = path.posix.normalize(relative);
  if (normalized === '..' || normalized.startsWith('../') || normalized !== relative) {
    throw new ComfySftpError('SFTP_PATH_INVALID', 'Remote artifact path contains traversal.');
  }
  return path.posix.join('/incoming', normalized);
};

const sftpCall = <T>(operation: (callback: (error: Error | undefined | null, value: T) => void) => void) =>
  new Promise<T>((resolve, reject) => operation((error, value) => (error ? reject(error) : resolve(value))));

const statOrNull = async (sftp: SFTPWrapper, remotePath: string): Promise<any | null> => {
  try {
    return await sftpCall<any>(callback => sftp.lstat(remotePath, callback));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === '2') return null;
    throw error;
  }
};

const mkdirRecursive = async (sftp: SFTPWrapper, directory: string): Promise<void> => {
  const parts = directory.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current += `/${part}`;
    const info = await statOrNull(sftp, current);
    if (info) {
      if (!info.isDirectory()) throw new ComfySftpError('SFTP_PATH_UNSAFE', 'Remote upload path is not a directory.');
      continue;
    }
    await sftpCall<void>(callback => sftp.mkdir(current, callback));
  }
};

export type SftpProgress = (bytes: bigint) => Promise<void> | void;

export class ComfySftpTransport {
  constructor(
    private readonly options: {
      host: string;
      port: number;
      privateKey: Buffer | string;
      expectedFingerprint: string;
      username?: string;
      readyTimeoutMs?: number;
    },
  ) {}

  private async connect(): Promise<{ client: Client; sftp: SFTPWrapper }> {
    const client = new Client();
    const expected = normalizeFingerprint(this.options.expectedFingerprint);
    let hostKeyMismatch = false;
    await new Promise<void>((resolve, reject) => {
      client
        .once('ready', resolve)
        .once('error', reject)
        .connect({
          host: this.options.host,
          port: this.options.port,
          username: this.options.username || 'aitk-upload',
          privateKey: this.options.privateKey,
          readyTimeout: this.options.readyTimeoutMs || 30_000,
          hostVerifier: (key: Buffer) => {
            const actual = fingerprint(key);
            const left = Buffer.from(actual);
            const right = Buffer.from(expected);
            const matches = left.length === right.length && crypto.timingSafeEqual(left, right);
            hostKeyMismatch = !matches;
            return matches;
          },
        });
    }).catch(error => {
      client.end();
      const authenticationFailed =
        (error as { level?: string })?.level === 'client-authentication' ||
        /authentication|private key|all configured authentication/i.test(
          error instanceof Error ? error.message : String(error),
        );
      throw new ComfySftpError(
        hostKeyMismatch ? 'SFTP_HOST_KEY_MISMATCH' : authenticationFailed ? 'SFTP_AUTH_FAILED' : 'SFTP_UNAVAILABLE',
        hostKeyMismatch
          ? 'The Pod SFTP host key did not match the authenticated control channel.'
          : authenticationFailed
            ? 'The Pod rejected the configured SFTP key.'
            : 'The Pod SFTP service is temporarily unavailable.',
        !hostKeyMismatch && !authenticationFailed,
      );
    });
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) =>
      client.sftp((error, wrapper) => (error ? reject(error) : resolve(wrapper))),
    );
    return { client, sftp };
  }

  async uploadArtifact(
    artifact: Pick<
      ComfyWorkspaceArtifact,
      'local_path' | 'remote_relative_path' | 'byte_length' | 'source_size' | 'source_mtime_ms'
    >,
    onProgress?: SftpProgress,
  ): Promise<bigint> {
    const local = await fs.promises.lstat(artifact.local_path, { bigint: true });
    if (
      !local.isFile() ||
      local.isSymbolicLink() ||
      local.size !== artifact.source_size ||
      local.mtimeMs !== artifact.source_mtime_ms
    ) {
      throw new ComfySftpError('STAGED_ARTIFACT_CHANGED', 'A staged workspace artifact changed before transfer.');
    }
    try {
      const destination = safeRemotePath(artifact.remote_relative_path);
      const partial = `${destination}.partial`;
      const { client, sftp } = await this.connect();
      try {
        await mkdirRecursive(sftp, path.posix.dirname(destination));
        const existingDestination = await statOrNull(sftp, destination);
        if (existingDestination) {
          if (!existingDestination.isFile() || BigInt(existingDestination.size) !== artifact.byte_length) {
            throw new ComfySftpError('SFTP_REMOTE_COLLISION', 'Remote artifact exists with the wrong type or size.');
          }
          return artifact.byte_length;
        }
        const partialInfo = await statOrNull(sftp, partial);
        let offset = partialInfo ? BigInt(partialInfo.size) : BigInt(0);
        if (partialInfo && !partialInfo.isFile())
          throw new ComfySftpError('SFTP_PATH_UNSAFE', 'Remote partial is not a regular file.');
        if (offset > artifact.byte_length) {
          await sftpCall<void>(callback => sftp.unlink(partial, callback));
          offset = BigInt(0);
        }
        if (offset < artifact.byte_length) {
          await new Promise<void>((resolve, reject) => {
            const source = fs.createReadStream(artifact.local_path, { start: Number(offset) });
            const destinationStream = sftp.createWriteStream(partial, {
              flags: offset > BigInt(0) ? 'a' : 'w',
              mode: 0o600,
            });
            let transferred = offset;
            let lastReportedAt = 0;
            let progressQueue = Promise.resolve();
            let progressError: unknown;
            const report = (snapshot: bigint) => {
              if (!onProgress || progressError) return;
              progressQueue = progressQueue
                .then(() => onProgress(snapshot))
                .catch(error => {
                  progressError = error;
                });
            };
            source.on('data', chunk => {
              transferred += BigInt(chunk.length);
              const now = Date.now();
              if (now - lastReportedAt >= 1_000) {
                lastReportedAt = now;
                report(transferred);
              }
            });
            source.once('error', reject);
            destinationStream.once('error', reject);
            destinationStream.once('close', () => {
              report(transferred);
              void progressQueue.then(() => (progressError ? reject(progressError) : resolve()));
            });
            source.pipe(destinationStream);
          });
        }
        const complete = await statOrNull(sftp, partial);
        if (!complete?.isFile() || BigInt(complete.size) !== artifact.byte_length) {
          throw new ComfySftpError('SFTP_SIZE_MISMATCH', 'Remote partial size does not match the staged artifact.');
        }
        await sftpCall<void>(callback => sftp.rename(partial, destination, callback));
        return artifact.byte_length;
      } finally {
        sftp.end();
        client.end();
      }
    } catch (error) {
      if (error instanceof ComfySftpError) throw error;
      throw new ComfySftpError('SFTP_TRANSFER_INTERRUPTED', 'The SFTP transfer was interrupted.', true);
    }
  }

  async commit(manifestPath: string): Promise<void> {
    try {
      const manifestStats = await fs.promises.stat(manifestPath, { bigint: true });
      const manifestArtifact = {
        local_path: manifestPath,
        remote_relative_path: 'workspace-manifest.json',
        byte_length: manifestStats.size,
        source_size: manifestStats.size,
        source_mtime_ms: manifestStats.mtimeMs,
      };
      await this.uploadArtifact(manifestArtifact as any);
      const { client, sftp } = await this.connect();
      try {
        const marker = '/incoming/COMMITTED';
        await new Promise<void>((resolve, reject) => {
          const stream = sftp.createWriteStream(marker, { flags: 'w', mode: 0o600 });
          stream.once('error', reject);
          stream.once('close', resolve);
          stream.end('1\n');
        });
      } finally {
        sftp.end();
        client.end();
      }
    } catch (error) {
      if (error instanceof ComfySftpError) throw error;
      throw new ComfySftpError('SFTP_COMMIT_INTERRUPTED', 'The remote bundle commit was interrupted.', true);
    }
  }

  async downloadOutput(
    remoteRelativePath: string,
    destination: string,
    expectedBytes: bigint,
    expectedSha256: string,
  ): Promise<void> {
    const remote = safeRemotePath(remoteRelativePath);
    const { client, sftp } = await this.connect();
    const temporary = `${destination}.partial`;
    try {
      const remoteInfo = await statOrNull(sftp, remote);
      if (!remoteInfo?.isFile() || BigInt(remoteInfo.size) !== expectedBytes) {
        throw new ComfySftpError('OUTPUT_REMOTE_CHANGED', 'Remote generated image changed before download.');
      }
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      const partialInfo = await fs.promises.lstat(temporary, { bigint: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (partialInfo && (!partialInfo.isFile() || partialInfo.isSymbolicLink() || partialInfo.size > expectedBytes)) {
        await fs.promises.rm(temporary, { force: true });
      }
      const resumable = await fs.promises.lstat(temporary, { bigint: true }).catch(() => null);
      const offset = resumable?.isFile() ? resumable.size : BigInt(0);
      await new Promise<void>((resolve, reject) => {
        const source = sftp.createReadStream(remote, { start: Number(offset) });
        const output = fs.createWriteStream(temporary, {
          flags: offset > BigInt(0) ? 'a' : 'w',
          mode: 0o600,
        });
        source.once('error', reject);
        output.once('error', reject);
        output.once('close', resolve);
        source.pipe(output);
      });
      const local = await fs.promises.lstat(temporary, { bigint: true });
      const digest = await new Promise<string>((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const input = fs.createReadStream(temporary);
        input.once('error', reject);
        input.on('data', chunk => hash.update(chunk));
        input.once('end', () => resolve(hash.digest('hex')));
      });
      if (!local.isFile() || local.size !== expectedBytes || digest !== expectedSha256) {
        await fs.promises.rm(temporary, { force: true });
        throw new ComfySftpError('OUTPUT_HASH_MISMATCH', 'Downloaded generated image failed verification.');
      }
      await fs.promises.rename(temporary, destination).catch(async error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await fs.promises.rm(destination, { force: true });
        await fs.promises.rename(temporary, destination);
      });
    } catch (error) {
      if (error instanceof ComfySftpError) throw error;
      throw new ComfySftpError('SFTP_OUTPUT_INTERRUPTED', 'The generated-image download was interrupted.', true);
    } finally {
      sftp.end();
      client.end();
    }
  }
}
