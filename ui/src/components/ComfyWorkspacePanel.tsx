'use client';

import { useEffect, useMemo, useState } from 'react';
import { apiClient } from '@/utils/api';

type Checkpoint = {
  fileName: string;
  label: string;
  size: number;
  step: number | null;
  isFinal: boolean;
};

export type ComfyWorkspaceSummary = {
  id: string;
  state: string;
  phase: string;
  exportMode: 'comparison' | 'single';
  selectedCheckpoint: string | null;
  preserveOutputs: boolean;
  workflowName: string;
  checkpointCount: number;
  actualGpu: string | null;
  hourlyRate: number | null;
  estimatedMaxCost: number | null;
  maxRuntimeMinutes: number;
  idleTimeoutMinutes: number;
  expiresAt: string | null;
  readyAt: string | null;
  lastUserActivityAt: string | null;
  lastQueueActivityAt: string | null;
  idleGraceStartedAt: string | null;
  bytesPlanned: number;
  bytesTransferred: number;
  outputSyncState: string;
  outputSyncError: string | null;
  terminationReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type TemporaryH100Capability = {
  available: boolean;
  error: string | null;
  configurationErrors: string[];
  durationChoices: number[];
  defaultMaxHours: number;
  idleMinutes: number;
  maxHourlyRate: number;
  gpuIds: string[];
  comparisonCheckpointBytes: number;
  comparisonContainerDiskGb: number;
  activeWorkspace: ComfyWorkspaceSummary | null;
};

const terminal = new Set(['terminated', 'expired', 'failed_confirmed_absent']);
const openable = new Set(['ready', 'busy', 'idle_grace']);
const errorMessage = (error: any, fallback: string) => error?.response?.data?.error || error?.message || fallback;

const phaseLabel: Record<string, string> = {
  requested: 'Queued',
  preparing_bundle: 'Preparing immutable checkpoint bundle',
  waiting_for_capacity: 'Waiting for a Secure Cloud H100',
  provisioning: 'Provisioning H100',
  provisioning_unknown: 'Reconciling provider response',
  booting: 'Downloading and verifying pinned Turbo BF16 models',
  transferring: 'Securely transferring checkpoints',
  validating: 'Validating workflow and ComfyUI',
  ready: 'Ready',
  busy: 'Generation running',
  idle_grace: 'Idle deletion grace period',
  syncing_outputs: 'Copying generated images',
  terminating: 'Terminating Pod',
  terminated: 'Terminated',
  expired: 'Automatically expired',
  failed_confirmed_absent: 'Failed; provider absence confirmed',
};

const bytes = (value: number) => {
  if (!value) return '0 B';
  if (value < 1024 ** 2) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 ** 3).toFixed(value >= 1024 ** 3 ? 2 : 3)} GB`;
};

export default function ComfyWorkspacePanel({
  jobId,
  checkpoints,
  capability,
}: {
  jobId: string;
  checkpoints: Checkpoint[];
  capability: TemporaryH100Capability;
}) {
  const [workspace, setWorkspace] = useState<ComfyWorkspaceSummary | null>(capability.activeWorkspace);
  const [mode, setMode] = useState<'comparison' | 'single'>('comparison');
  const [checkpoint, setCheckpoint] = useState(checkpoints[0]?.fileName || '');
  const [maxHours, setMaxHours] = useState(capability.defaultMaxHours);
  const [preserveOutputs, setPreserveOutputs] = useState(true);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => setWorkspace(capability.activeWorkspace), [capability.activeWorkspace]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!workspace || terminal.has(workspace.state)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await apiClient.get<{ workspace: ComfyWorkspaceSummary }>(
          `/api/comfyui/workspaces/${workspace.id}`,
        );
        if (!cancelled) setWorkspace(response.data.workspace);
      } catch (requestError) {
        if (!cancelled) setError(errorMessage(requestError, 'Could not refresh workspace status.'));
      }
    };
    const timer = window.setInterval(() => void poll(), 3_000);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspace?.id, workspace?.state]);

  const estimated = useMemo(() => capability.maxHourlyRate * maxHours, [capability.maxHourlyRate, maxHours]);

  const create = async () => {
    const checkpointBytes =
      mode === 'comparison'
        ? capability.comparisonCheckpointBytes
        : checkpoints.find(item => item.fileName === checkpoint)?.size || 0;
    const confirmed = window.confirm(
      `Launch a billable Secure Cloud H100 workspace for up to ${maxHours} hour(s)? ` +
        `${mode === 'comparison' ? checkpoints.length : 1} checkpoint(s), ${bytes(checkpointBytes)}, ` +
        `maximum estimate $${estimated.toFixed(2)}. The Pod and unsynchronized data will be deleted.`,
    );
    if (!confirmed) return;
    setWorking('create');
    setError('');
    try {
      const response = await apiClient.post<{ workspace: ComfyWorkspaceSummary }>(
        `/api/jobs/${jobId}/comfyui/workspaces`,
        {
          requestKey: crypto.randomUUID(),
          mode,
          checkpoint: mode === 'single' ? checkpoint : undefined,
          maxHours,
          preserveOutputs,
        },
      );
      setWorkspace(response.data.workspace);
    } catch (requestError) {
      const existing = (requestError as any)?.response?.data?.workspace;
      if (existing) setWorkspace(existing);
      setError(errorMessage(requestError, 'Could not request a temporary workspace.'));
    } finally {
      setWorking('');
    }
  };

  const open = async () => {
    if (!workspace) return;
    setWorking('open');
    setError('');
    try {
      const response = await apiClient.post<{ url: string }>(`/api/comfyui/workspaces/${workspace.id}/open`);
      window.open(response.data.url, '_blank', 'noopener,noreferrer');
    } catch (requestError) {
      setError(errorMessage(requestError, 'Could not create a workspace session.'));
    } finally {
      setWorking('');
    }
  };

  const sync = async () => {
    if (!workspace) return;
    setWorking('sync');
    setError('');
    try {
      const response = await apiClient.post<{ workspace: ComfyWorkspaceSummary }>(
        `/api/comfyui/workspaces/${workspace.id}/sync-outputs`,
      );
      setWorkspace(response.data.workspace);
    } catch (requestError) {
      setError(errorMessage(requestError, 'Could not request output synchronization.'));
    } finally {
      setWorking('');
    }
  };

  const terminate = async (mode: 'graceful' | 'immediate') => {
    if (!workspace) return;
    const warning =
      mode === 'immediate'
        ? 'Terminate this billable Pod immediately? Unsynchronized generated images may be lost.'
        : 'Copy stable generated images, then terminate this billable Pod?';
    if (!window.confirm(warning)) return;
    setWorking(mode);
    setError('');
    try {
      const response = await apiClient.delete<{ workspace: ComfyWorkspaceSummary }>(
        `/api/comfyui/workspaces/${workspace.id}?mode=${mode}`,
      );
      setWorkspace(response.data.workspace);
    } catch (requestError) {
      setError(errorMessage(requestError, 'Could not request Pod termination.'));
    } finally {
      setWorking('');
    }
  };

  if (workspace) {
    const progress =
      workspace.bytesPlanned > 0
        ? Math.min(100, Math.round((workspace.bytesTransferred / workspace.bytesPlanned) * 100))
        : 0;
    const activityTimes = [workspace.readyAt, workspace.lastUserActivityAt, workspace.lastQueueActivityAt]
      .filter((value): value is string => Boolean(value))
      .map(value => new Date(value).getTime())
      .filter(Number.isFinite);
    const idleReference = activityTimes.length ? Math.max(...activityTimes) : null;
    const idleDeadline = workspace.idleGraceStartedAt
      ? new Date(workspace.idleGraceStartedAt).getTime() + 2 * 60_000
      : idleReference == null
        ? null
        : idleReference + workspace.idleTimeoutMinutes * 60_000;
    const idleRemaining = idleDeadline == null ? null : Math.max(0, Math.ceil((idleDeadline - now) / 1_000));
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-violet-800 bg-violet-950/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-semibold text-violet-100">{phaseLabel[workspace.state] || workspace.state}</p>
              <p className="mt-1 text-xs text-gray-400">
                Workspace {workspace.id.slice(0, 8)} · {workspace.actualGpu || 'H100 pending'}
              </p>
            </div>
            {workspace.hourlyRate != null && (
              <span className="rounded bg-gray-800 px-2 py-1 text-xs">${workspace.hourlyRate.toFixed(2)}/hour</span>
            )}
          </div>
          <p className="mt-3 text-sm text-gray-300">{workspace.phase.replaceAll('_', ' ')}</p>
          {workspace.bytesPlanned > 0 && !openable.has(workspace.state) && !terminal.has(workspace.state) && (
            <div className="mt-3">
              <div className="h-2 overflow-hidden rounded bg-gray-800">
                <div className="h-full bg-violet-600" style={{ width: `${progress}%` }} />
              </div>
              <p className="mt-1 text-xs text-gray-400">
                {bytes(workspace.bytesTransferred)} / {bytes(workspace.bytesPlanned)}
              </p>
            </div>
          )}
          <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-gray-400 sm:grid-cols-2">
            <span>Hard maximum: {workspace.maxRuntimeMinutes / 60} hour(s)</span>
            <span>Idle deletion: {workspace.idleTimeoutMinutes} minutes</span>
            {workspace.expiresAt && <span>Provider expiry: {new Date(workspace.expiresAt).toLocaleString()}</span>}
            {idleRemaining != null && (
              <span>
                {workspace.idleGraceStartedAt ? 'Deletion grace' : 'Idle deletion'}: {Math.floor(idleRemaining / 60)}:
                {String(idleRemaining % 60).padStart(2, '0')}
              </span>
            )}
            {workspace.estimatedMaxCost != null && (
              <span>Estimated maximum: ${workspace.estimatedMaxCost.toFixed(2)}</span>
            )}
          </div>
          {workspace.state === 'idle_grace' && (
            <p className="mt-3 rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-amber-100">
              This workspace is idle and is entering automatic deletion. Open it now to record activity.
            </p>
          )}
          {workspace.errorMessage && (
            <p className="mt-3 rounded border border-red-800 bg-red-950/40 px-3 py-2 text-red-200">
              {workspace.errorCode ? `${workspace.errorCode}: ` : ''}
              {workspace.errorMessage}
            </p>
          )}
          {workspace.outputSyncError && <p className="mt-2 text-amber-300">{workspace.outputSyncError}</p>}
        </div>
        {!terminal.has(workspace.state) ? (
          <div className="flex flex-wrap justify-end gap-2">
            {openable.has(workspace.state) && (
              <>
                <button
                  type="button"
                  onClick={sync}
                  disabled={Boolean(working)}
                  className="rounded bg-gray-700 px-3 py-2 disabled:opacity-50"
                >
                  {working === 'sync' ? 'Requesting…' : 'Sync outputs'}
                </button>
                <button
                  type="button"
                  onClick={open}
                  disabled={Boolean(working)}
                  className="rounded bg-violet-700 px-3 py-2 font-medium text-white disabled:opacity-50"
                >
                  {working === 'open' ? 'Opening…' : 'Open ComfyUI'}
                </button>
                <button
                  type="button"
                  onClick={() => terminate('graceful')}
                  disabled={Boolean(working)}
                  className="rounded bg-amber-700 px-3 py-2 text-white disabled:opacity-50"
                >
                  Sync then terminate
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => terminate('immediate')}
              disabled={Boolean(working)}
              className="rounded bg-red-800 px-3 py-2 text-white disabled:opacity-50"
            >
              Terminate immediately
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setWorkspace(null)} className="rounded bg-gray-700 px-3 py-2">
            Configure another workspace
          </button>
        )}
        {error && (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!capability.available && (
        <div className="rounded-lg border border-amber-800 bg-amber-950/30 p-3 text-amber-100">
          <p>{capability.error || 'Temporary H100 workspaces are not configured.'}</p>
          {capability.configurationErrors.length > 1 && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
              {capability.configurationErrors.slice(1).map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <fieldset className="space-y-2" disabled={!capability.available || Boolean(working)}>
        <legend className="font-medium">Workflow</legend>
        <label className="flex gap-2 rounded border border-gray-700 p-3">
          <input type="radio" checked={mode === 'comparison'} onChange={() => setMode('comparison')} />
          <span>
            <strong>All checkpoints + No LoRA</strong>
            <span className="block text-gray-400">Recommended matched comparison with a clean baseline.</span>
          </span>
        </label>
        <label className="flex gap-2 rounded border border-gray-700 p-3">
          <input type="radio" checked={mode === 'single'} onChange={() => setMode('single')} />
          <span>
            <strong>One checkpoint</strong>
            <span className="block text-gray-400">A smaller single-LoRA workflow.</span>
          </span>
        </label>
        {mode === 'single' && (
          <select
            value={checkpoint}
            onChange={event => setCheckpoint(event.target.value)}
            className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2"
          >
            {checkpoints.map(item => (
              <option key={item.fileName} value={item.fileName}>
                {item.label}
              </option>
            ))}
          </select>
        )}
      </fieldset>
      <label className="block">
        <span className="mb-1 block font-medium">Maximum duration</span>
        <select
          value={maxHours}
          onChange={event => setMaxHours(Number(event.target.value))}
          disabled={!capability.available}
          className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2"
        >
          {capability.durationChoices.map(hours => (
            <option key={hours} value={hours}>
              {hours} hour{hours === 1 ? '' : 's'}
            </option>
          ))}
        </select>
      </label>
      <label className="flex gap-2">
        <input
          type="checkbox"
          checked={preserveOutputs}
          onChange={event => setPreserveOutputs(event.target.checked)}
          disabled={!capability.available}
        />
        <span>Copy generated images back to this job before automatic termination</span>
      </label>
      <div className="rounded border border-gray-700 p-3 text-xs text-gray-300">
        Ceiling estimate: up to <strong>${estimated.toFixed(2)}</strong> at ${capability.maxHourlyRate.toFixed(2)}/hour.
        Capacity waiting is not billable. The provider maximum can interrupt an active generation.
        <span className="mt-1 block">
          {mode === 'comparison' ? checkpoints.length : 1} checkpoint(s) Â·{' '}
          {bytes(
            mode === 'comparison'
              ? capability.comparisonCheckpointBytes
              : checkpoints.find(item => item.fileName === checkpoint)?.size || 0,
          )}{' '}
          Â· {capability.comparisonContainerDiskGb} GB container disk Â· {capability.gpuIds.join(' or ')}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={create}
          disabled={
            !capability.available || !checkpoints.length || Boolean(working) || (mode === 'single' && !checkpoint)
          }
          className="rounded bg-violet-700 px-4 py-2 font-medium text-white disabled:opacity-50"
        >
          {working === 'create' ? 'Requesting workspace…' : 'Launch temporary H100 workspace'}
        </button>
      </div>
    </div>
  );
}
