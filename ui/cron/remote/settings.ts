import path from 'path';
import prisma from '../prisma';
import { getTrainingFolder } from '../paths';

export const RUNPOD_QUEUE_KEY = 'runpod:h100';
export const RUNPOD_SETTING_KEYS = [
  'RUNPOD_ENDPOINT_ID',
  'RUNPOD_NETWORK_VOLUME_ID',
  'RUNPOD_S3_ENDPOINT',
  'RUNPOD_S3_REGION',
  'RUNPOD_S3_BUCKET',
  'RUNPOD_WORKER_IMAGE_DIGEST',
  'RUNPOD_EXECUTION_TIMEOUT_MS',
  'RUNPOD_TTL_MS',
  'RUNPOD_BUNDLE_DIRECTORY',
] as const;

export const AWS_ARCHIVE_SETTING_KEYS = ['AWS_ARCHIVE_BUCKET', 'AWS_ARCHIVE_REGION', 'AWS_ARCHIVE_PREFIX'] as const;

export type AwsArchiveConfig = {
  enabled: boolean;
  bucket: string;
  region: string;
  prefix: string;
};

export type RunPodConfig = {
  enabled: boolean;
  apiKey: string;
  endpointId: string;
  networkVolumeId: string;
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessId: string;
  s3Secret: string;
  workerImageDigest: string;
  executionTimeoutMs: number;
  ttlMs: number;
  bundleDirectory: string;
  apiBaseUrl: string;
  restBaseUrl: string;
};

const readPositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const getRunPodConfig = async (): Promise<RunPodConfig> => {
  const rows = await prisma.settings.findMany({ where: { key: { in: [...RUNPOD_SETTING_KEYS] } } });
  const stored = Object.fromEntries(rows.map(row => [row.key, row.value.trim()]));
  const value = (key: (typeof RUNPOD_SETTING_KEYS)[number]) => process.env[key]?.trim() || stored[key] || '';
  const trainingFolder = await getTrainingFolder();
  const endpointId = value('RUNPOD_ENDPOINT_ID');
  const networkVolumeId = value('RUNPOD_NETWORK_VOLUME_ID');
  const s3Endpoint = value('RUNPOD_S3_ENDPOINT');
  let inferredS3Region = '';
  try {
    inferredS3Region = new URL(s3Endpoint).hostname.match(/^s3api-(.+)\.runpod\.io$/i)?.[1]?.toUpperCase() || '';
  } catch {
    // Validation reports malformed URLs below.
  }
  return {
    enabled: process.env.AI_TOOLKIT_RUNPOD_ENABLED === '1',
    apiKey: process.env.RUNPOD_API_KEY?.trim() || '',
    endpointId,
    networkVolumeId,
    s3Endpoint,
    s3Region: value('RUNPOD_S3_REGION') || inferredS3Region,
    s3Bucket: value('RUNPOD_S3_BUCKET') || networkVolumeId,
    s3AccessId: process.env.RUNPOD_S3_ACCESS_ID?.trim() || '',
    s3Secret: process.env.RUNPOD_S3_SECRET?.trim() || '',
    workerImageDigest: value('RUNPOD_WORKER_IMAGE_DIGEST'),
    executionTimeoutMs: readPositiveInteger(value('RUNPOD_EXECUTION_TIMEOUT_MS'), 3 * 60 * 60 * 1000),
    ttlMs: readPositiveInteger(value('RUNPOD_TTL_MS'), 6 * 60 * 60 * 1000),
    bundleDirectory: value('RUNPOD_BUNDLE_DIRECTORY') || path.join(trainingFolder, '.bundles'),
    apiBaseUrl: process.env.RUNPOD_API_BASE_URL?.trim() || 'https://api.runpod.ai/v2',
    restBaseUrl: process.env.RUNPOD_REST_BASE_URL?.trim() || 'https://rest.runpod.io/v1',
  };
};

export const validateRunPodConfig = (config: RunPodConfig): string[] => {
  const errors: string[] = [];
  if (!config.enabled) errors.push('RunPod support is disabled; set AI_TOOLKIT_RUNPOD_ENABLED=1.');
  if (!config.apiKey) errors.push('RUNPOD_API_KEY is not configured.');
  if (!config.endpointId) errors.push('RUNPOD_ENDPOINT_ID is not configured.');
  if (!config.networkVolumeId) errors.push('RUNPOD_NETWORK_VOLUME_ID is not configured.');
  if (!config.s3Endpoint) errors.push('RUNPOD_S3_ENDPOINT is not configured.');
  else {
    try {
      const endpoint = new URL(config.s3Endpoint);
      if (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(endpoint.hostname)) {
        errors.push('RUNPOD_S3_ENDPOINT must use HTTPS.');
      }
    } catch {
      errors.push('RUNPOD_S3_ENDPOINT is not a valid URL.');
    }
  }
  if (!config.s3Bucket) errors.push('RUNPOD_S3_BUCKET or RUNPOD_NETWORK_VOLUME_ID is not configured.');
  else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(config.s3Bucket)) errors.push('RUNPOD_S3_BUCKET is invalid.');
  if (!config.s3AccessId) errors.push('RUNPOD_S3_ACCESS_ID is not configured.');
  if (!/^[A-Z]{2,4}-[A-Z0-9]+-\d+$/i.test(config.s3Region)) {
    errors.push('RUNPOD_S3_REGION must be the network-volume datacenter ID, for example EU-RO-1.');
  }
  if (!config.s3Secret) errors.push('RUNPOD_S3_SECRET is not configured.');
  if (!/@sha256:[0-9a-f]{64}$/i.test(config.workerImageDigest)) {
    errors.push('RUNPOD_WORKER_IMAGE_DIGEST must be an immutable image@sha256 digest.');
  }
  if (config.executionTimeoutMs > 7 * 24 * 60 * 60 * 1000) errors.push('RunPod execution timeout exceeds 7 days.');
  if (config.ttlMs > 7 * 24 * 60 * 60 * 1000) errors.push('RunPod TTL exceeds 7 days.');
  if (config.ttlMs <= config.executionTimeoutMs) errors.push('RunPod TTL must exceed the execution timeout.');
  if (!path.isAbsolute(config.bundleDirectory))
    errors.push('RUNPOD_BUNDLE_DIRECTORY must resolve to an absolute local path.');
  return errors;
};

export const runPodSecretStatus = () => ({
  apiKeyConfigured: Boolean(process.env.RUNPOD_API_KEY?.trim()),
  s3AccessIdConfigured: Boolean(process.env.RUNPOD_S3_ACCESS_ID?.trim()),
  s3SecretConfigured: Boolean(process.env.RUNPOD_S3_SECRET?.trim()),
  hfTokenConfigured: Boolean(process.env.HF_TOKEN?.trim()),
  source: 'environment',
});

export const getAwsArchiveConfig = async (): Promise<AwsArchiveConfig> => {
  const rows = await prisma.settings.findMany({ where: { key: { in: [...AWS_ARCHIVE_SETTING_KEYS] } } });
  const stored = Object.fromEntries(rows.map(row => [row.key, row.value.trim()]));
  const value = (key: (typeof AWS_ARCHIVE_SETTING_KEYS)[number]) => process.env[key]?.trim() || stored[key] || '';
  return {
    enabled: process.env.AI_TOOLKIT_AWS_ARCHIVE_ENABLED === '1',
    bucket: value('AWS_ARCHIVE_BUCKET'),
    region: value('AWS_ARCHIVE_REGION') || process.env.AWS_REGION?.trim() || 'us-east-1',
    prefix: (value('AWS_ARCHIVE_PREFIX') || 'ai-toolkit').replace(/^\/+|\/+$/g, ''),
  };
};
