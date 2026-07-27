import type { RunPodComfyConfig } from './settings';
import { safeErrorMessage } from '../remote/redact';

export class ComfyPodClientError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
    public ambiguous = false,
  ) {
    super(message);
  }
}

export type ManagedPod = {
  id: string;
  name: string;
  image: string;
  status: string;
  gpu: string;
  hourlyRate: number | null;
  containerDiskGb: number | null;
  volumeGb: number;
  networkVolumeId: string | null;
  publicIp: string | null;
  sshHost: string | null;
  sshPort: number | null;
  ports: string[];
  raw: Record<string, unknown>;
};

export type CreateManagedPodInput = {
  workspaceId: string;
  name: string;
  gpuId: string;
  containerDiskGb: number;
  terminateAfter: Date;
  environment: Record<string, string>;
};

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

const text = (value: unknown): string => String(value ?? '').trim();
const finite = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const portStrings = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.flatMap(item =>
      typeof item === 'string' ? [item] : item && typeof item === 'object' ? [JSON.stringify(item)] : [],
    );
  }
  return text(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
};

export const parseManagedPod = (raw: Record<string, any>): ManagedPod => {
  const machine = raw.machine || {};
  const gpu =
    raw.gpu?.displayName ||
    raw.gpu?.display_name ||
    raw.gpuType?.displayName ||
    machine.gpuDisplayName ||
    raw.actualGpu ||
    '';
  const portMappings = raw.portMappings || raw.port_mappings || {};
  const runtimePorts = Array.isArray(raw.runtime?.ports) ? raw.runtime.ports : [];
  const runtimeSsh = runtimePorts.find(
    (item: any) => Number(item?.privatePort ?? item?.private_port ?? item?.containerPort) === 22,
  );
  const sshMapping =
    portMappings['22'] ||
    portMappings['22/tcp'] ||
    runtimeSsh ||
    (Array.isArray(raw.ports)
      ? raw.ports.find((item: any) => Number(item?.privatePort ?? item?.private_port ?? item?.containerPort) === 22)
      : undefined);
  const sshPort = finite(
    typeof sshMapping === 'number'
      ? sshMapping
      : (sshMapping?.publicPort ?? sshMapping?.public_port ?? sshMapping?.externalPort),
  );
  const volume = finite(raw.volumeInGb ?? raw.volume_in_gb ?? raw.volume?.size ?? 0) || 0;
  return {
    id: text(raw.id || raw.podId || raw.pod_id),
    name: text(raw.name),
    image: text(raw.imageName || raw.image_name || raw.image),
    status: text(raw.desiredStatus || raw.desired_status || raw.status).toUpperCase(),
    gpu: text(gpu),
    hourlyRate: finite(raw.costPerHr ?? raw.cost_per_hr ?? raw.hourlyRate),
    containerDiskGb: finite(raw.containerDiskInGb ?? raw.container_disk_in_gb ?? raw.containerDiskGb),
    volumeGb: volume,
    networkVolumeId: text(raw.networkVolumeId || raw.network_volume_id || raw.networkVolume?.id) || null,
    publicIp: text(raw.publicIp || raw.public_ip || raw.runtime?.publicIp || runtimeSsh?.ip) || null,
    sshHost: text(raw.publicIp || raw.public_ip || raw.runtime?.publicIp || runtimeSsh?.ip) || null,
    sshPort,
    ports: portStrings(raw.ports),
    raw,
  };
};

export class ComfyPodClient {
  constructor(
    private readonly config: RunPodComfyConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleeper: (milliseconds: number) => Promise<unknown> = sleep,
  ) {}

  private async request<T>(
    url: string,
    init: RequestInit,
    retrySafe: boolean,
    allowNotFound = false,
  ): Promise<T | null> {
    const attempts = retrySafe ? 4 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 30_000);
      try {
        const response = await this.fetchImpl(url, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            Accept: 'application/json',
            'User-Agent': 'ai-toolkit-comfy/1.0',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...(init.headers || {}),
          },
          signal: abort.signal,
        });
        if (allowNotFound && response.status === 404) return null;
        const bodyText = await response.text();
        let body: any = {};
        if (bodyText) {
          try {
            body = JSON.parse(bodyText);
          } catch {
            throw new ComfyPodClientError(
              'POD_RESPONSE_INVALID',
              `RunPod returned non-JSON HTTP ${response.status}.`,
              response.status,
            );
          }
        }
        if (!response.ok) {
          const message = safeErrorMessage(body?.error || body?.message || `RunPod HTTP ${response.status}`);
          if (!retrySafe || !retryableStatuses.has(response.status) || attempt === attempts) {
            throw new ComfyPodClientError(
              response.status === 401 || response.status === 403
                ? 'POD_AUTH_FAILED'
                : response.status === 429
                  ? 'POD_RATE_LIMITED'
                  : 'POD_REQUEST_FAILED',
              message,
              response.status,
              !retrySafe && retryableStatuses.has(response.status),
            );
          }
          lastError = new Error(message);
          const retryAfter = Number(response.headers.get('retry-after'));
          await this.sleeper(
            Number.isFinite(retryAfter)
              ? Math.min(retryAfter * 1000, 15_000)
              : Math.min(10_000, 500 * 2 ** (attempt - 1)),
          );
          continue;
        }
        return body as T;
      } catch (error) {
        if (error instanceof ComfyPodClientError) throw error;
        lastError = error;
        if (!retrySafe || attempt === attempts) {
          throw new ComfyPodClientError(
            retrySafe ? 'POD_UNAVAILABLE' : 'POD_CREATE_UNKNOWN',
            safeErrorMessage(error),
            undefined,
            !retrySafe,
          );
        }
        await this.sleeper(Math.min(10_000, 500 * 2 ** (attempt - 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new ComfyPodClientError('POD_UNAVAILABLE', safeErrorMessage(lastError));
  }

  async create(input: CreateManagedPodInput): Promise<ManagedPod> {
    if (!this.config.gpuIds.includes(input.gpuId))
      throw new ComfyPodClientError('POD_GPU_FORBIDDEN', 'Requested GPU is outside the strict H100 allowlist.');
    const mutation = `mutation createPod($input: PodFindAndDeployOnDemandInput!) {
      podFindAndDeployOnDemand(input: $input) {
        id name imageName desiredStatus costPerHr containerDiskInGb volumeInGb volumeMountPath
        gpuCount memoryInGb vcpuCount ports lastStatusChange env
        machine { gpuDisplayName location }
      }
    }`;
    const graphInput = {
      cloudType: 'SECURE',
      containerDiskInGb: input.containerDiskGb,
      ...(this.config.registryAuthId
        ? { containerRegistryAuthId: this.config.registryAuthId }
        : {}),
      env: Object.entries(input.environment).map(([key, value]) => ({ key, value })),
      gpuCount: 1,
      gpuTypeId: input.gpuId,
      imageName: this.config.imageDigest,
      name: input.name,
      ports: '8188/http,22/tcp',
      startSsh: true,
      supportPublicIp: true,
      volumeInGb: 0,
      terminateAfter: input.terminateAfter.toISOString(),
    };
    const response = await this.request<any>(
      this.config.graphQlUrl,
      { method: 'POST', body: JSON.stringify({ query: mutation, variables: { input: graphInput } }) },
      false,
    );
    if (response?.errors?.length) {
      const message = safeErrorMessage(
        response.errors
          .map((item: any) => item?.message)
          .filter(Boolean)
          .join(' '),
      );
      const capacity = /capacity|stock|available|deploy/i.test(message);
      throw new ComfyPodClientError(
        capacity ? 'POD_CAPACITY' : 'POD_CREATE_FAILED',
        message || 'RunPod rejected the Pod request.',
      );
    }
    const raw = response?.data?.podFindAndDeployOnDemand;
    if (!raw?.id)
      throw new ComfyPodClientError(
        'POD_RESPONSE_INVALID',
        'RunPod Pod creation did not return an ID.',
        undefined,
        true,
      );
    return parseManagedPod(raw);
  }

  async list(): Promise<ManagedPod[]> {
    const body = await this.request<any>(`${this.config.restBaseUrl}/pods`, { method: 'GET' }, true);
    const rows = Array.isArray(body) ? body : Array.isArray(body?.pods) ? body.pods : [];
    return rows.map((item: any) => parseManagedPod(item));
  }

  async findByName(name: string): Promise<ManagedPod[]> {
    return (await this.list()).filter(pod => pod.name === name);
  }

  async get(id: string): Promise<ManagedPod | null> {
    const body = await this.request<any>(
      `${this.config.restBaseUrl}/pods/${encodeURIComponent(id)}`,
      { method: 'GET' },
      true,
      true,
    );
    if (!body) return null;
    let combined = body;
    try {
      const query = `query myPods {
        myself {
          pods {
            id imageName desiredStatus costPerHr containerDiskInGb volumeInGb ports
            machine { gpuDisplayName location }
            runtime { ports { ip isIpPublic privatePort publicPort type } }
          }
        }
      }`;
      const response = await this.request<any>(
        this.config.graphQlUrl,
        { method: 'POST', body: JSON.stringify({ query, variables: {} }) },
        true,
      );
      const legacy = response?.data?.myself?.pods?.find((item: any) => item?.id === id);
      if (legacy) combined = { ...body, ...legacy, env: body.env, networkVolumeId: body.networkVolumeId };
    } catch {
      // The REST identity remains useful while runtime port discovery retries
      // on a later reconciliation tick.
    }
    return parseManagedPod(combined);
  }

  async delete(id: string): Promise<'deleted' | 'absent'> {
    const result = await this.request<any>(
      `${this.config.restBaseUrl}/pods/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      true,
      true,
    );
    return result == null ? 'absent' : 'deleted';
  }

  verifyIdentity(pod: ManagedPod, expected: CreateManagedPodInput): string[] {
    const errors: string[] = [];
    if (pod.name !== expected.name) errors.push('Pod name does not match the workspace identity.');
    if (!this.config.gpuIds.includes(pod.gpu as any))
      errors.push('Provider returned a non-H100 or unapproved H100 GPU.');
    if (pod.image !== this.config.imageDigest) errors.push('Provider returned the wrong immutable image.');
    if (pod.networkVolumeId || pod.volumeGb !== 0) errors.push('Provider attached persistent storage.');
    if (pod.containerDiskGb == null) errors.push('Provider did not attest the container disk size.');
    else if (pod.containerDiskGb !== expected.containerDiskGb)
      errors.push('Provider returned the wrong container disk size.');
    if (pod.hourlyRate == null) errors.push('Provider did not attest the hourly rate.');
    else if (pod.hourlyRate > this.config.maxHourlyRate)
      errors.push('Provider hourly rate exceeds the configured ceiling.');
    const portText = pod.ports.join(',').toLowerCase();
    if (pod.ports.length && (!portText.includes('8188') || !portText.includes('22')))
      errors.push('Provider did not expose the required authenticated HTTP and SFTP ports.');
    return errors;
  }
}
