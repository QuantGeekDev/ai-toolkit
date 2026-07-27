import { safeErrorMessage } from '../remote/redact';

export type RemoteWorkspaceStatus = {
  workspaceId: string;
  phase: string;
  ready: boolean;
  modelsVerified?: boolean;
  comfyVerified?: boolean;
  queueRunning: boolean;
  queuePending: number;
  sshHostKeyFingerprint?: string;
  lastUserActivityAt?: string;
  lastQueueActivityAt?: string;
  idleGraceStartedAt?: string;
  terminationReason?: string;
  errorCode?: string;
  errorMessage?: string;
  modelManifestSha256?: string;
  imageDigest?: string;
};

export type RemoteOutputCatalog = {
  workspaceId: string;
  bytes: number;
  files: Array<{ path: string; remotePath: string; bytes: number; sha256: string }>;
};

export class ComfyControlError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export class ComfyControlClient {
  constructor(
    private readonly baseUrl: string,
    private readonly controllerToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(route: string, init: RequestInit = {}): Promise<T> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 20_000);
    try {
      const response = await this.fetchImpl(new URL(route, this.baseUrl), {
        ...init,
        headers: {
          Authorization: `Bearer ${this.controllerToken}`,
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers || {}),
        },
        signal: abort.signal,
      });
      const responseText = await response.text();
      let body: any = {};
      try {
        body = responseText ? JSON.parse(responseText) : {};
      } catch {
        throw new ComfyControlError(
          'REMOTE_STATUS_INVALID',
          `Workspace sidecar returned non-JSON HTTP ${response.status}.`,
          response.status,
        );
      }
      if (!response.ok) {
        throw new ComfyControlError(
          response.status === 401 || response.status === 403 ? 'REMOTE_AUTH_FAILED' : 'REMOTE_STATUS_FAILED',
          safeErrorMessage(body?.error || `Workspace sidecar HTTP ${response.status}.`),
          response.status,
        );
      }
      return body as T;
    } catch (error) {
      if (error instanceof ComfyControlError) throw error;
      throw new ComfyControlError('REMOTE_STATUS_UNAVAILABLE', safeErrorMessage(error));
    } finally {
      clearTimeout(timer);
    }
  }

  status(): Promise<RemoteWorkspaceStatus> {
    return this.request('/aitk/control/status');
  }

  install(manifestSha256: string): Promise<RemoteWorkspaceStatus> {
    return this.request('/aitk/control/install', {
      method: 'POST',
      body: JSON.stringify({ manifestSha256 }),
    });
  }

  requestGracefulTermination(): Promise<RemoteWorkspaceStatus> {
    return this.request('/aitk/control/terminate', { method: 'POST', body: JSON.stringify({ mode: 'graceful' }) });
  }

  outputs(): Promise<RemoteOutputCatalog> {
    return this.request('/aitk/control/outputs');
  }
}
