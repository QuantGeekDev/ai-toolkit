import { describe, expect, it, vi } from 'vitest';
import { ComfyPodClient, ComfyPodClientError, parseManagedPod } from './podClient';
import type { RunPodComfyConfig } from './settings';

const config = {
  apiKey: 'secret-api-key',
  graphQlUrl: 'https://api.runpod.test/graphql',
  restBaseUrl: 'https://rest.runpod.test/v1',
  imageDigest: `ghcr.io/example/comfy@sha256:${'a'.repeat(64)}`,
  gpuIds: ['NVIDIA H100 80GB HBM3'],
  maxHourlyRate: 3.5,
} as RunPodComfyConfig;

const input = {
  workspaceId: 'workspace-1',
  name: 'aitk-comfy-workspace-1',
  gpuId: 'NVIDIA H100 80GB HBM3',
  containerDiskGb: 120,
  terminateAfter: new Date('2026-07-27T14:00:00.000Z'),
  environment: { AITK_WORKSPACE_ID: 'workspace-1' },
};

describe('Comfy Pod client', () => {
  it('creates exact Secure Cloud, zero-volume, provider-expiring H100 payloads', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      expect(request.variables.input).toMatchObject({
        cloudType: 'SECURE',
        containerDiskInGb: 120,
        gpuCount: 1,
        gpuTypeId: 'NVIDIA H100 80GB HBM3',
        imageName: config.imageDigest,
        ports: '8188/http,22/tcp',
        startSsh: true,
        supportPublicIp: true,
        volumeInGb: 0,
        terminateAfter: '2026-07-27T14:00:00.000Z',
      });
      expect(request.variables.input).not.toHaveProperty('networkVolumeId');
      return new Response(
        JSON.stringify({
          data: {
            podFindAndDeployOnDemand: {
              id: 'pod-1',
              name: input.name,
              imageName: config.imageDigest,
              desiredStatus: 'RUNNING',
              costPerHr: 2.99,
              containerDiskInGb: 120,
              volumeInGb: 0,
              ports: ['8188/http', '22/tcp'],
              machine: { gpuDisplayName: 'NVIDIA H100 80GB HBM3' },
            },
          },
        }),
        { status: 200 },
      );
    });
    const pod = await new ComfyPodClient(config, fetchMock as any).create(input);
    expect(pod.id).toBe('pod-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new ComfyPodClient(config).verifyIdentity(pod, input)).toEqual([]);
  });

  it('never blindly retries an ambiguous create', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('connection reset');
    });
    await expect(new ComfyPodClient(config, fetchMock as any).create(input)).rejects.toMatchObject({
      code: 'POD_CREATE_UNKNOWN',
      ambiguous: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects price, image, GPU, and persistent-volume drift', () => {
    const pod = parseManagedPod({
      id: 'pod-1',
      name: input.name,
      imageName: 'mutable:latest',
      costPerHr: 9,
      volumeInGb: 10,
      networkVolumeId: 'persistent',
      machine: { gpuDisplayName: 'NVIDIA A100' },
      ports: ['8188/http'],
    });
    expect(new ComfyPodClient(config).verifyIdentity(pod, input).join(' ')).toMatch(
      /non-H100|wrong immutable image|persistent storage|hourly rate|required/,
    );
  });

  it('treats delete 404 as confirmed absence', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
    await expect(new ComfyPodClient(config, fetchMock as any).delete('gone')).resolves.toBe('absent');
  });
});
