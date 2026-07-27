'use client';

import { useState } from 'react';
import { Workflow } from 'lucide-react';
import { Job } from '@prisma/client';
import { Modal } from '@/components/Modal';
import { apiClient } from '@/utils/api';
import ComfyWorkspacePanel, { type TemporaryH100Capability } from '@/components/ComfyWorkspacePanel';

type Checkpoint = {
  fileName: string;
  label: string;
  size: number;
  step: number | null;
  isFinal: boolean;
};

type ExportInfo = {
  available: boolean;
  error: string | null;
  checkpoints: Checkpoint[];
  comfyUiUrl: string;
  local: { available: boolean; error: string | null; comfyUiUrl: string };
  temporaryH100: TemporaryH100Capability;
};

type ExportResult = {
  mode: 'comparison' | 'single';
  checkpoints: string[];
  loraNames: string[];
  checkpoint?: string;
  loraName?: string;
  workflowName: string;
  comfyUiUrl: string;
};

const message = (error: any, fallback: string) => error?.response?.data?.error || error?.message || fallback;
const fileSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export default function ComfyUIExportButton({ job, iconClassName }: { job: Job; iconClassName: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [destination, setDestination] = useState<'temporary' | 'local'>('temporary');
  const [info, setInfo] = useState<ExportInfo | null>(null);
  const [mode, setMode] = useState<'comparison' | 'single'>('comparison');
  const [checkpoint, setCheckpoint] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ExportResult | null>(null);

  const open = async () => {
    setIsOpen(true);
    setLoading(true);
    setDestination('temporary');
    setMode('comparison');
    setError('');
    setResult(null);
    try {
      const response = await apiClient.get<ExportInfo>(`/api/jobs/${job.id}/comfyui`);
      setInfo(response.data);
      setCheckpoint(response.data.checkpoints[0]?.fileName || '');
    } catch (requestError) {
      setInfo(null);
      setError(message(requestError, 'Could not inspect this Krea 2 job.'));
    } finally {
      setLoading(false);
    }
  };

  const createLocal = async () => {
    if ((mode === 'single' && !checkpoint) || submitting) return;
    setSubmitting(true);
    setError('');
    setResult(null);
    try {
      const response = await apiClient.post<ExportResult>(`/api/jobs/${job.id}/comfyui`, {
        mode,
        checkpoint: mode === 'single' ? checkpoint : undefined,
      });
      setResult(response.data);
    } catch (requestError) {
      setError(message(requestError, 'Could not create the local ComfyUI workflow.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        className="ml-1 text-gray-200 hover:text-white sm:ml-2"
        title="Open in ComfyUI"
        aria-label="Open in ComfyUI"
      >
        <Workflow className={iconClassName} />
      </button>
      <Modal
        isOpen={isOpen}
        onClose={() => !submitting && setIsOpen(false)}
        title={`Krea 2 ComfyUI — ${job.name}`}
        size="lg"
        closeOnOverlayClick={!submitting}
      >
        <div className="space-y-4 text-sm text-gray-200">
          <p>
            Use the pinned Krea 2 Turbo BF16 workflow remotely, or copy the workflow to an existing local ComfyUI
            installation. Both default to a no-LoRA baseline plus every saved checkpoint.
          </p>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="ComfyUI destination">
            <button
              type="button"
              role="radio"
              aria-checked={destination === 'temporary'}
              onClick={() => setDestination('temporary')}
              className={`rounded-lg border p-3 text-left ${destination === 'temporary' ? 'border-violet-600 bg-violet-950/30' : 'border-gray-700'}`}
            >
              <strong className="block">Temporary H100</strong>
              <span className="text-gray-400">Recommended · Secure Cloud · automatic deletion</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={destination === 'local'}
              onClick={() => setDestination('local')}
              className={`rounded-lg border p-3 text-left ${destination === 'local' ? 'border-blue-600 bg-blue-950/30' : 'border-gray-700'}`}
            >
              <strong className="block">Local ComfyUI</strong>
              <span className="text-gray-400">Copy files to the configured installation</span>
            </button>
          </div>
          <div className="rounded-lg border border-blue-800 bg-blue-950/30 px-3 py-2 text-blue-100">
            Use the highlighted <strong>Aspect Ratio</strong> selector for 9:16 portrait or 16:9 landscape.
          </div>
          {loading && <p className="text-gray-400">Finding saved checkpoints…</p>}
          {!loading && info && destination === 'temporary' && (
            <ComfyWorkspacePanel jobId={job.id} checkpoints={info.checkpoints} capability={info.temporaryH100} />
          )}
          {!loading && info && destination === 'local' && (
            <div className="space-y-4">
              {!info.local.available && (
                <p className="rounded border border-red-800 bg-red-950/30 p-3 text-red-200">{info.local.error}</p>
              )}
              {info.checkpoints.length === 0 && (
                <p className="rounded border border-amber-800 bg-amber-950/30 p-3 text-amber-100">
                  This job has no saved `.safetensors` checkpoints.
                </p>
              )}
              {info.local.available && info.checkpoints.length > 0 && !result && (
                <>
                  <fieldset className="space-y-2" disabled={submitting}>
                    <legend className="font-medium">Workflow</legend>
                    <label className="flex gap-2 rounded border border-gray-700 p-3">
                      <input type="radio" checked={mode === 'comparison'} onChange={() => setMode('comparison')} />
                      <span>
                        <strong>All checkpoints + No LoRA</strong>
                        <span className="block text-gray-400">{info.checkpoints.length + 1} matched branches.</span>
                      </span>
                    </label>
                    <label className="flex gap-2 rounded border border-gray-700 p-3">
                      <input type="radio" checked={mode === 'single'} onChange={() => setMode('single')} />
                      <span>
                        <strong>One checkpoint only</strong>
                      </span>
                    </label>
                  </fieldset>
                  {mode === 'single' && (
                    <select
                      value={checkpoint}
                      onChange={event => setCheckpoint(event.target.value)}
                      className="w-full rounded border border-gray-600 bg-gray-800 px-3 py-2"
                    >
                      {info.checkpoints.map(item => (
                        <option key={item.fileName} value={item.fileName}>
                          {item.label} ({fileSize(item.size)})
                        </option>
                      ))}
                    </select>
                  )}
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={createLocal}
                      disabled={submitting || (mode === 'single' && !checkpoint)}
                      className="rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50"
                    >
                      {submitting ? 'Creating workflow…' : 'Create local workflow'}
                    </button>
                  </div>
                </>
              )}
              {result && (
                <div className="rounded border border-green-800 bg-green-950/30 p-3 text-green-100">
                  <p className="font-semibold">Ready in local ComfyUI</p>
                  <p className="mt-1 font-mono text-xs">{result.workflowName}</p>
                  <a
                    href={result.comfyUiUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-block rounded bg-green-700 px-3 py-2 text-white"
                  >
                    Open ComfyUI
                  </a>
                </div>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="rounded border border-red-800 bg-red-950/30 p-3 text-red-200">
              {error}
            </p>
          )}
          <div className="flex justify-end border-t border-gray-700 pt-4">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              disabled={submitting}
              className="rounded bg-gray-700 px-4 py-2 disabled:opacity-50"
            >
              Close
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
