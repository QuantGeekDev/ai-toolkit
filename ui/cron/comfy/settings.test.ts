import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { KREA2_TURBO_MODEL_MANIFEST_SHA256 } from './modelManifest';
import { COMFY_DURATION_CHOICES, type RunPodComfyConfig, validateRunPodComfyConfig } from './settings';

const valid = (): RunPodComfyConfig => ({
  enabled: true,
  apiKey: 'runpod-test-key',
  deploymentAuth: 'a-strong-deployment-password',
  masterSecret: Buffer.alloc(32, 7).toString('base64'),
  sshPrivateKeyPath: 'C:\\secure\\comfy-ed25519',
  sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeForParserOnly',
  imageDigest: `ghcr.io/example/comfy@sha256:${'a'.repeat(64)}`,
  gpuIds: ['NVIDIA H100 80GB HBM3', 'NVIDIA H100 PCIe'],
  maxHourlyRate: 3.5,
  defaultMaxHours: 2,
  allowedMaxHours: [...COMFY_DURATION_CHOICES],
  idleMinutes: 60,
  minContainerDiskGb: 100,
  maxContainerDiskGb: 200,
  outputAllowanceGb: 20,
  capacityWaitMinutes: 15,
  maxActive: 1,
  hfSecretName: 'aitk_hf_read',
  registryAuthId: 'registry-auth-1',
  stagingDirectory: 'C:\\secure\\comfy-staging',
  capabilityReportPath: 'C:\\secure\\comfy-capability.json',
  graphQlUrl: 'https://api.runpod.io/graphql',
  restBaseUrl: 'https://rest.runpod.io/v1',
  modelManifestSha256: KREA2_TURBO_MODEL_MANIFEST_SHA256,
});

describe('RunPod ComfyUI settings', () => {
  it('accepts the fail-closed production contract without touching key files', () => {
    expect(validateRunPodComfyConfig(valid(), false)).toEqual([]);
  });

  it('verifies that the configured private and OpenSSH public keys match', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aitk-comfy-key-'));
    const privatePath = path.join(root, 'id_ed25519');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', privatePath]);
    const config = valid();
    config.sshPrivateKeyPath = privatePath;
    config.sshPublicKey = fs.readFileSync(`${privatePath}.pub`, 'utf8').trim();
    config.capabilityReportPath = path.join(root, 'capability.json');
    fs.writeFileSync(
      config.capabilityReportPath,
      JSON.stringify({
        live: {
          image: config.imageDigest,
          podScopedKeyPresent: true,
          crossPodDeleteDenied: true,
          selfDeleteConfirmed: true,
          providerTerminateAfterConfirmed: true,
          networkVolume: false,
          persistentVolumeGb: 0,
        },
      }),
    );
    try {
      expect(validateRunPodComfyConfig(config, true)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['disabled', (value: RunPodComfyConfig) => (value.enabled = false), 'disabled'],
    ['missing auth', (value: RunPodComfyConfig) => (value.deploymentAuth = ''), 'AI_TOOLKIT_AUTH'],
    ['placeholder auth', (value: RunPodComfyConfig) => (value.deploymentAuth = 'changeme'), 'AI_TOOLKIT_AUTH'],
    [
      'short master secret',
      (value: RunPodComfyConfig) => (value.masterSecret = Buffer.alloc(16).toString('base64')),
      'MASTER_SECRET',
    ],
    ['mutable image', (value: RunPodComfyConfig) => (value.imageDigest = 'ghcr.io/example/comfy:latest'), 'immutable'],
    ['GPU fallback', (value: RunPodComfyConfig) => value.gpuIds.push('NVIDIA A100'), 'H100'],
    ['too many workspaces', (value: RunPodComfyConfig) => (value.maxActive = 2), 'MAX_ACTIVE'],
    [
      'invalid registry auth ID',
      (value: RunPodComfyConfig) => (value.registryAuthId = 'bad id'),
      'REGISTRY_AUTH_ID',
    ],
    ['relative staging', (value: RunPodComfyConfig) => (value.stagingDirectory = 'output/staging'), 'must be absolute'],
  ])('rejects %s', (_name, mutate, expected) => {
    const config = valid();
    mutate(config);
    expect(validateRunPodComfyConfig(config, false).join(' ')).toContain(expected);
  });
});
