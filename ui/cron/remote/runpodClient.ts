import type { RunPodConfig } from './settings';
import { safeErrorMessage } from './redact';

export class RunPodClientError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
    public ambiguous = false,
  ) {
    super(message);
  }
}

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

export type RunPodStatus = {
  id: string;
  status: string;
  output?: unknown;
  error?: unknown;
  executionTime?: number;
  delayTime?: number;
};

export class RunPodClient {
  constructor(
    private readonly config: RunPodConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleeper: (milliseconds: number) => Promise<unknown> = sleep,
    private readonly random: () => number = Math.random,
  ) {}

  private async requestJson<T>(url: string, init: RequestInit, retrySafe: boolean): Promise<T> {
    const maxAttempts = retrySafe ? 4 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await this.fetchImpl(url, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...(init.headers || {}),
          },
          signal: controller.signal,
        });
        const text = await response.text();
        let body: any = {};
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            throw new RunPodClientError(
              'REMOTE_RESPONSE_INVALID',
              `RunPod returned non-JSON HTTP ${response.status}`,
              response.status,
            );
          }
        }
        if (!response.ok) {
          const message = String(body?.error || body?.message || `RunPod HTTP ${response.status}`);
          const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
          if (!retrySafe || !retryable || attempt === maxAttempts) {
            const code =
              response.status === 401 || response.status === 403
                ? 'REMOTE_AUTH_FAILED'
                : response.status === 429
                  ? 'REMOTE_RATE_LIMITED'
                  : response.status === 404
                    ? 'REMOTE_NOT_FOUND'
                    : 'REMOTE_REQUEST_FAILED';
            throw new RunPodClientError(code, safeErrorMessage(message), response.status);
          }
          lastError = new Error(message);
        } else {
          return body as T;
        }
      } catch (error) {
        if (error instanceof RunPodClientError) throw error;
        lastError = error;
        if (!retrySafe || attempt === maxAttempts) {
          throw new RunPodClientError(
            retrySafe ? 'REMOTE_UNAVAILABLE' : 'REMOTE_SUBMISSION_UNKNOWN',
            safeErrorMessage(error),
            undefined,
            !retrySafe,
          );
        }
      } finally {
        clearTimeout(timer);
      }
      const delay = Math.min(10_000, 500 * 2 ** (attempt - 1)) * this.random();
      await this.sleeper(delay);
    }
    throw new RunPodClientError('REMOTE_UNAVAILABLE', safeErrorMessage(lastError));
  }

  async submit(input: Record<string, unknown>): Promise<{ id: string; status: string }> {
    const url = `${this.config.apiBaseUrl}/${encodeURIComponent(this.config.endpointId)}/run`;
    const body = {
      input,
      policy: {
        executionTimeout: this.config.executionTimeoutMs,
        ttl: this.config.ttlMs,
        lowPriority: false,
      },
    };
    const result = await this.requestJson<{ id?: string; status?: string }>(
      url,
      { method: 'POST', body: JSON.stringify(body) },
      false,
    );
    if (!result.id) throw new RunPodClientError('REMOTE_RESPONSE_INVALID', 'RunPod submission did not return a job ID');
    return { id: result.id, status: result.status || 'IN_QUEUE' };
  }

  status(jobId: string): Promise<RunPodStatus> {
    return this.requestJson(
      `${this.config.apiBaseUrl}/${encodeURIComponent(this.config.endpointId)}/status/${encodeURIComponent(jobId)}`,
      { method: 'GET' },
      true,
    );
  }

  cancel(jobId: string): Promise<{ id: string; status: string }> {
    return this.requestJson(
      `${this.config.apiBaseUrl}/${encodeURIComponent(this.config.endpointId)}/cancel/${encodeURIComponent(jobId)}`,
      { method: 'POST' },
      false,
    );
  }

  health(): Promise<Record<string, unknown>> {
    return this.requestJson(
      `${this.config.apiBaseUrl}/${encodeURIComponent(this.config.endpointId)}/health`,
      { method: 'GET' },
      true,
    );
  }

  async endpoint(): Promise<Record<string, any>> {
    const endpoints = await this.requestJson<Record<string, any>[]>(
      `${this.config.restBaseUrl}/endpoints?includeTemplate=true&includeWorkers=true`,
      { method: 'GET' },
      true,
    );
    const endpoint = endpoints.find(item => String(item.id) === this.config.endpointId);
    if (!endpoint) throw new RunPodClientError('REMOTE_NOT_FOUND', 'Configured RunPod endpoint was not returned.', 404);
    return endpoint;
  }

  async preflight(): Promise<{
    ok: boolean;
    errors: string[];
    warnings: string[];
    endpoint: Record<string, unknown>;
    health: Record<string, unknown>;
  }> {
    const [endpoint, health] = await Promise.all([this.endpoint(), this.health()]);
    const errors: string[] = [];
    const warnings: string[] = [];
    const minimumWorkers = Number(endpoint.workersMin ?? endpoint.workers_min ?? endpoint.scaler?.workersMin);
    const maximumWorkers = Number(endpoint.workersMax ?? endpoint.workers_max ?? endpoint.scaler?.workersMax);
    const volume = String(endpoint.networkVolumeId ?? endpoint.network_volume_id ?? endpoint.networkVolume?.id ?? '');
    const gpuCount = Number(endpoint.gpuCount ?? endpoint.gpu_count);
    const idleTimeout = Number(endpoint.idleTimeout ?? endpoint.idle_timeout);
    const computeType = String(endpoint.computeType ?? endpoint.compute_type ?? '').toUpperCase();
    const gpuIds = endpoint.gpuIds ?? endpoint.gpu_ids ?? endpoint.gpus ?? endpoint.gpuTypeIds ?? [];
    const gpuText = JSON.stringify(gpuIds).toUpperCase();
    const workers = Array.isArray(endpoint.workers) ? endpoint.workers : [];
    const endpointRegionsRaw = endpoint.dataCenterIds ?? endpoint.data_center_ids ?? [];
    const endpointRegions = (
      Array.isArray(endpointRegionsRaw) ? endpointRegionsRaw : String(endpointRegionsRaw).split(',')
    )
      .map((value: unknown) => String(value).trim().toUpperCase())
      .filter(Boolean);
    if (!Number.isFinite(minimumWorkers)) errors.push('RunPod endpoint response did not expose workersMin.');
    else if (minimumWorkers !== 0) errors.push(`RunPod workersMin must be 0, got ${minimumWorkers}.`);
    if (!Number.isFinite(maximumWorkers)) errors.push('RunPod endpoint response did not expose workersMax.');
    else if (maximumWorkers !== 1) errors.push(`RunPod workersMax must be 1, got ${maximumWorkers}.`);
    if (volume !== this.config.networkVolumeId)
      errors.push('RunPod endpoint network volume does not match RUNPOD_NETWORK_VOLUME_ID.');
    if (computeType && computeType !== 'GPU')
      errors.push(`RunPod endpoint compute type must be GPU, got ${computeType}.`);
    if (!Number.isFinite(gpuCount)) errors.push('RunPod endpoint response did not expose gpuCount.');
    else if (gpuCount !== 1) errors.push(`RunPod endpoint must use one GPU per worker, got ${gpuCount}.`);
    if (!Number.isFinite(idleTimeout)) errors.push('RunPod endpoint response did not expose idleTimeout.');
    else if (idleTimeout !== 5) errors.push(`RunPod idleTimeout must be 5 seconds, got ${idleTimeout}.`);
    if (!gpuText.includes('H100')) errors.push('RunPod endpoint must request an H100 GPU.');
    if (Array.isArray(gpuIds) && gpuIds.length > 1)
      errors.push('RunPod endpoint has GPU fallbacks; strict H100 mode permits one GPU type only.');
    if (workers.length > 0)
      errors.push(
        `RunPod endpoint already has ${workers.length} active worker(s); wait for scale-to-zero before submitting.`,
      );
    if (endpointRegions.length && !endpointRegions.includes(this.config.s3Region.toUpperCase())) {
      errors.push('RunPod endpoint datacenters do not include the network volume S3 region.');
    }
    const image = String(
      endpoint.template?.image ??
        endpoint.template?.imageName ??
        endpoint.template?.image_name ??
        endpoint.imageName ??
        '',
    );
    if (image && image !== this.config.workerImageDigest)
      errors.push('RunPod endpoint image does not match RUNPOD_WORKER_IMAGE_DIGEST.');
    if (!image)
      warnings.push('RunPod API did not expose the endpoint image; the worker will enforce its digest at startup.');
    const configuredWorkerIdentity = String(
      endpoint.env?.AITK_WORKER_IMAGE_DIGEST ?? endpoint.template?.env?.AITK_WORKER_IMAGE_DIGEST ?? '',
    );
    if (configuredWorkerIdentity && configuredWorkerIdentity !== this.config.workerImageDigest) {
      errors.push('RunPod endpoint AITK_WORKER_IMAGE_DIGEST does not match the configured immutable image.');
    } else if (!configuredWorkerIdentity) {
      warnings.push('RunPod API did not expose AITK_WORKER_IMAGE_DIGEST; startup fitness checks will require it.');
    }
    return { ok: errors.length === 0, errors, warnings, endpoint, health };
  }
}
