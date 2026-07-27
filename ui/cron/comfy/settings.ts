import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import prisma from '../prisma';
import { KREA2_TURBO_MODEL_MANIFEST_SHA256 } from './modelManifest';

export const RUNPOD_COMFY_SETTING_KEYS = [
  'RUNPOD_COMFY_IMAGE_DIGEST',
  'RUNPOD_COMFY_GPU_IDS',
  'RUNPOD_COMFY_MAX_HOURLY_RATE',
  'RUNPOD_COMFY_DEFAULT_MAX_HOURS',
  'RUNPOD_COMFY_ALLOWED_MAX_HOURS',
  'RUNPOD_COMFY_IDLE_MINUTES',
  'RUNPOD_COMFY_MIN_CONTAINER_DISK_GB',
  'RUNPOD_COMFY_MAX_CONTAINER_DISK_GB',
  'RUNPOD_COMFY_OUTPUT_ALLOWANCE_GB',
  'RUNPOD_COMFY_CAPACITY_WAIT_MINUTES',
  'RUNPOD_COMFY_MAX_ACTIVE',
  'RUNPOD_COMFY_HF_SECRET_NAME',
  'RUNPOD_COMFY_SSH_PUBLIC_KEY',
  'RUNPOD_COMFY_LOCAL_STAGING_DIRECTORY',
  'RUNPOD_COMFY_CAPABILITY_REPORT',
] as const;

export const COMFY_DURATION_CHOICES = [1, 2, 4, 8] as const;
export type ComfyDurationHours = (typeof COMFY_DURATION_CHOICES)[number];

export type RunPodComfyConfig = {
  enabled: boolean;
  apiKey: string;
  deploymentAuth: string;
  masterSecret: string;
  sshPrivateKeyPath: string;
  sshPublicKey: string;
  imageDigest: string;
  gpuIds: string[];
  maxHourlyRate: number;
  defaultMaxHours: ComfyDurationHours;
  allowedMaxHours: ComfyDurationHours[];
  idleMinutes: number;
  minContainerDiskGb: number;
  maxContainerDiskGb: number;
  outputAllowanceGb: number;
  capacityWaitMinutes: number;
  maxActive: number;
  hfSecretName: string;
  stagingDirectory: string;
  capabilityReportPath: string;
  graphQlUrl: string;
  restBaseUrl: string;
  modelManifestSha256: string;
};

const asNumber = (value: string, fallback: number) => (value.trim() ? Number(value) : fallback);
const defaultStaging = path.resolve(process.cwd(), '..', 'output', '.comfy-workspaces');
const defaultCapabilityReport = path.resolve(
  process.cwd(),
  '..',
  'remote',
  'runpod',
  'comfyui',
  'capability-contract.json',
);

export const getRunPodComfyConfig = async (): Promise<RunPodComfyConfig> => {
  const rows = await prisma.settings.findMany({ where: { key: { in: [...RUNPOD_COMFY_SETTING_KEYS] } } });
  const stored = Object.fromEntries(rows.map(row => [row.key, row.value.trim()]));
  const value = (key: (typeof RUNPOD_COMFY_SETTING_KEYS)[number], fallback = '') =>
    process.env[key]?.trim() || stored[key] || fallback;
  const allowed = value('RUNPOD_COMFY_ALLOWED_MAX_HOURS', '1,2,4,8')
    .split(',')
    .map(item => Number(item.trim()))
    .filter((item): item is ComfyDurationHours => COMFY_DURATION_CHOICES.includes(item as ComfyDurationHours));
  const defaultHours = asNumber(value('RUNPOD_COMFY_DEFAULT_MAX_HOURS'), 2);
  return {
    enabled: process.env.AI_TOOLKIT_RUNPOD_COMFY_ENABLED === '1',
    apiKey: process.env.RUNPOD_API_KEY?.trim() || '',
    deploymentAuth: process.env.AI_TOOLKIT_AUTH?.trim() || '',
    masterSecret: process.env.AI_TOOLKIT_COMFY_MASTER_SECRET?.trim() || '',
    sshPrivateKeyPath: process.env.RUNPOD_COMFY_SSH_PRIVATE_KEY_PATH?.trim() || '',
    sshPublicKey: value('RUNPOD_COMFY_SSH_PUBLIC_KEY'),
    imageDigest: value('RUNPOD_COMFY_IMAGE_DIGEST'),
    gpuIds: value('RUNPOD_COMFY_GPU_IDS', 'NVIDIA H100 80GB HBM3,NVIDIA H100 PCIe')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
    maxHourlyRate: asNumber(value('RUNPOD_COMFY_MAX_HOURLY_RATE'), 3.5),
    defaultMaxHours: defaultHours as ComfyDurationHours,
    allowedMaxHours: allowed,
    idleMinutes: asNumber(value('RUNPOD_COMFY_IDLE_MINUTES'), 60),
    minContainerDiskGb: asNumber(value('RUNPOD_COMFY_MIN_CONTAINER_DISK_GB'), 100),
    maxContainerDiskGb: asNumber(value('RUNPOD_COMFY_MAX_CONTAINER_DISK_GB'), 200),
    outputAllowanceGb: asNumber(value('RUNPOD_COMFY_OUTPUT_ALLOWANCE_GB'), 20),
    capacityWaitMinutes: asNumber(value('RUNPOD_COMFY_CAPACITY_WAIT_MINUTES'), 15),
    maxActive: asNumber(value('RUNPOD_COMFY_MAX_ACTIVE'), 1),
    hfSecretName: value('RUNPOD_COMFY_HF_SECRET_NAME', 'aitk_hf_read'),
    stagingDirectory: value('RUNPOD_COMFY_LOCAL_STAGING_DIRECTORY', defaultStaging),
    capabilityReportPath: value('RUNPOD_COMFY_CAPABILITY_REPORT', defaultCapabilityReport),
    graphQlUrl: process.env.RUNPOD_GRAPHQL_URL?.trim() || 'https://api.runpod.io/graphql',
    restBaseUrl: process.env.RUNPOD_REST_BASE_URL?.trim() || 'https://rest.runpod.io/v1',
    modelManifestSha256: KREA2_TURBO_MODEL_MANIFEST_SHA256,
  };
};

const PLACEHOLDER_AUTH = /^(?:password|changeme|change-me|secret|admin|test|default|123456(?:78)?|ai-toolkit)$/i;

export const validateRunPodComfyConfig = (config: RunPodComfyConfig, checkFiles = true): string[] => {
  const errors: string[] = [];
  if (!config.enabled) errors.push('Temporary H100 ComfyUI workspaces are disabled.');
  if (!config.apiKey) errors.push('RUNPOD_API_KEY is not configured.');
  if (config.deploymentAuth.length < 16 || PLACEHOLDER_AUTH.test(config.deploymentAuth)) {
    errors.push('AI_TOOLKIT_AUTH must be a strong, non-placeholder value of at least 16 characters.');
  }
  let decodedSecret: Buffer | undefined;
  try {
    decodedSecret = Buffer.from(config.masterSecret, 'base64');
  } catch {
    // Reported below.
  }
  if (
    !decodedSecret ||
    decodedSecret.length < 32 ||
    decodedSecret.toString('base64').replace(/=+$/, '') !== config.masterSecret.replace(/=+$/, '')
  ) {
    errors.push('AI_TOOLKIT_COMFY_MASTER_SECRET must be valid base64 encoding at least 32 random bytes.');
  }
  if (!/@sha256:[0-9a-f]{64}$/i.test(config.imageDigest)) {
    errors.push('RUNPOD_COMFY_IMAGE_DIGEST must be an immutable image@sha256 digest.');
  }
  if (!config.gpuIds.length || config.gpuIds.some(id => !/^NVIDIA H100(?: 80GB HBM3| PCIe| NVL)$/.test(id))) {
    errors.push('RUNPOD_COMFY_GPU_IDS may contain only explicit NVIDIA H100 GPU IDs.');
  }
  if (!Number.isFinite(config.maxHourlyRate) || config.maxHourlyRate <= 0) {
    errors.push('RUNPOD_COMFY_MAX_HOURLY_RATE must be greater than zero.');
  }
  if (!config.allowedMaxHours.length || config.allowedMaxHours.some(value => !COMFY_DURATION_CHOICES.includes(value))) {
    errors.push('RUNPOD_COMFY_ALLOWED_MAX_HOURS must be a subset of 1,2,4,8.');
  }
  if (!config.allowedMaxHours.includes(config.defaultMaxHours)) {
    errors.push('RUNPOD_COMFY_DEFAULT_MAX_HOURS must be in the allowed duration list.');
  }
  if (config.idleMinutes !== 60 && process.env.NODE_ENV === 'production') {
    errors.push('RUNPOD_COMFY_IDLE_MINUTES must be 60 in production.');
  }
  if (!Number.isSafeInteger(config.idleMinutes) || config.idleMinutes < 1) {
    errors.push('RUNPOD_COMFY_IDLE_MINUTES must be a positive integer.');
  }
  if (
    !Number.isSafeInteger(config.minContainerDiskGb) ||
    !Number.isSafeInteger(config.maxContainerDiskGb) ||
    config.minContainerDiskGb < 100 ||
    config.maxContainerDiskGb > 200 ||
    config.minContainerDiskGb > config.maxContainerDiskGb
  ) {
    errors.push('ComfyUI container disk bounds must stay between 100 and 200 GB.');
  }
  if (!Number.isFinite(config.outputAllowanceGb) || config.outputAllowanceGb < 1 || config.outputAllowanceGb > 50) {
    errors.push('RUNPOD_COMFY_OUTPUT_ALLOWANCE_GB must be between 1 and 50.');
  }
  if (
    !Number.isSafeInteger(config.capacityWaitMinutes) ||
    config.capacityWaitMinutes < 1 ||
    config.capacityWaitMinutes > 60
  ) {
    errors.push('RUNPOD_COMFY_CAPACITY_WAIT_MINUTES must be an integer from 1 to 60.');
  }
  if (config.maxActive !== 1) errors.push('RUNPOD_COMFY_MAX_ACTIVE must be 1 in this release.');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,62}$/.test(config.hfSecretName)) {
    errors.push('RUNPOD_COMFY_HF_SECRET_NAME is invalid.');
  }
  if (!path.isAbsolute(config.stagingDirectory)) {
    errors.push('RUNPOD_COMFY_LOCAL_STAGING_DIRECTORY must be absolute.');
  }
  if (!path.isAbsolute(config.capabilityReportPath)) {
    errors.push('RUNPOD_COMFY_CAPABILITY_REPORT must be absolute.');
  } else if (checkFiles) {
    try {
      const report = JSON.parse(fs.readFileSync(config.capabilityReportPath, 'utf8'));
      const live = report?.live;
      if (
        live?.image !== config.imageDigest ||
        live?.podScopedKeyPresent !== true ||
        live?.crossPodDeleteDenied !== true ||
        live?.selfDeleteConfirmed !== true ||
        live?.providerTerminateAfterConfirmed !== true ||
        live?.networkVolume !== false ||
        live?.persistentVolumeGb !== 0
      ) {
        errors.push('The EPH-01 live capability report does not authorize this exact image.');
      }
    } catch {
      errors.push('RUNPOD_COMFY_CAPABILITY_REPORT is missing or invalid.');
    }
  }
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,3}(?: [^\r\n]+)?$/.test(config.sshPublicKey))
    errors.push('RUNPOD_COMFY_SSH_PUBLIC_KEY must be an Ed25519 public key.');
  if (!config.sshPrivateKeyPath || !path.isAbsolute(config.sshPrivateKeyPath)) {
    errors.push('RUNPOD_COMFY_SSH_PRIVATE_KEY_PATH must be an absolute path.');
  } else if (checkFiles) {
    try {
      const derived = execFileSync('ssh-keygen', ['-y', '-f', config.sshPrivateKeyPath], {
        encoding: 'utf8',
        timeout: 5_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .join(' ');
      const configured = config.sshPublicKey.trim().split(/\s+/).slice(0, 2).join(' ');
      const left = Buffer.from(derived);
      const right = Buffer.from(configured);
      if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
        errors.push('The configured SFTP key pair does not match.');
      }
    } catch {
      errors.push('The configured SFTP private/public key pair is unreadable or invalid.');
    }
  }
  return [...new Set(errors)];
};

export const runPodComfySecretStatus = () => ({
  apiKeyConfigured: Boolean(process.env.RUNPOD_API_KEY?.trim()),
  deploymentAuthConfigured: Boolean(process.env.AI_TOOLKIT_AUTH?.trim()),
  masterSecretConfigured: Boolean(process.env.AI_TOOLKIT_COMFY_MASTER_SECRET?.trim()),
  privateKeyConfigured: Boolean(process.env.RUNPOD_COMFY_SSH_PRIVATE_KEY_PATH?.trim()),
  source: 'environment' as const,
});
