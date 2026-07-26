'use client';

import { useState } from 'react';
import { Workflow } from 'lucide-react';
import { Job } from '@prisma/client';
import { Modal } from '@/components/Modal';
import { apiClient } from '@/utils/api';

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
};

type ExportResult = {
  checkpoint: string;
  loraName: string;
  workflowName: string;
  comfyUiUrl: string;
};

const errorMessage = (error: any, fallback: string) => error?.response?.data?.error || error?.message || fallback;

const fileSize = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export default function ComfyUIExportButton({ job, iconClassName }: { job: Job; iconClassName: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [info, setInfo] = useState<ExportInfo | null>(null);
  const [checkpoint, setCheckpoint] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ExportResult | null>(null);

  const open = async () => {
    setIsOpen(true);
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const response = await apiClient.get<ExportInfo>(`/api/jobs/${job.id}/comfyui`);
      setInfo(response.data);
      setCheckpoint(response.data.checkpoints[0]?.fileName || '');
    } catch (requestError) {
      setInfo(null);
      setError(errorMessage(requestError, 'Could not inspect this job or the ComfyUI installation.'));
    } finally {
      setLoading(false);
    }
  };

  const createWorkflow = async () => {
    if (!checkpoint || submitting) return;
    setSubmitting(true);
    setError('');
    setResult(null);
    try {
      const response = await apiClient.post<ExportResult>(`/api/jobs/${job.id}/comfyui`, { checkpoint });
      setResult(response.data);
    } catch (requestError) {
      setError(errorMessage(requestError, 'Could not create the ComfyUI workflow.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        className="ml-1 sm:ml-2 text-gray-200 hover:text-white"
        title="Send a checkpoint to ComfyUI"
        aria-label="Send a checkpoint to ComfyUI"
      >
        <Workflow className={iconClassName} />
      </button>
      <Modal
        isOpen={isOpen}
        onClose={() => {
          if (!submitting) setIsOpen(false);
        }}
        title={`Create Krea 2 ComfyUI workflow — ${job.name}`}
        size="lg"
        closeOnOverlayClick={!submitting}
      >
        <div className="space-y-4 text-sm text-gray-200">
          <p>
            Select a saved training step. AI Toolkit will copy it into ComfyUI&apos;s LoRA library and create a ready
            evaluation workflow. The original training file stays in place.
          </p>
          <div className="rounded-lg border border-blue-800 bg-blue-950/40 px-3 py-2 text-blue-100">
            Inside the generated workflow, use the highlighted <strong>Aspect Ratio</strong> selector to switch between
            9:16 portrait and 16:9 landscape.
          </div>

          {loading && <p className="text-gray-400">Finding saved checkpoints and checking ComfyUI…</p>}

          {!loading && info && (
            <>
              {!info.available && (
                <p className="rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-red-200">
                  {info.error || 'The configured ComfyUI installation is unavailable.'}
                </p>
              )}
              {info.available && info.checkpoints.length === 0 && (
                <p className="rounded-lg border border-yellow-800 bg-yellow-950/40 px-3 py-2 text-yellow-100">
                  This job does not have any saved `.safetensors` checkpoints yet.
                </p>
              )}
              {info.available && info.checkpoints.length > 0 && (
                <label className="block">
                  <span className="mb-1 block font-medium text-gray-100">Checkpoint</span>
                  <select
                    value={checkpoint}
                    onChange={event => {
                      setCheckpoint(event.target.value);
                      setResult(null);
                    }}
                    disabled={submitting}
                    className="w-full rounded-md border border-gray-600 bg-gray-800 px-3 py-2 text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  >
                    {info.checkpoints.map(item => (
                      <option key={item.fileName} value={item.fileName}>
                        {item.label} ({fileSize(item.size)})
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}

          {error && (
            <p className="rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-red-200" role="alert">
              {error}
            </p>
          )}

          {result && (
            <div className="space-y-2 rounded-lg border border-green-800 bg-green-950/40 px-3 py-3 text-green-100">
              <p className="font-semibold">Ready in ComfyUI</p>
              <p>
                Workflow: <span className="font-mono text-xs">{result.workflowName}</span>
              </p>
              <p>
                LoRA: <span className="font-mono text-xs">{result.loraName}</span>
              </p>
              <p className="text-green-200">
                Open ComfyUI, choose <strong>Workflows</strong>, then open the workflow above.
              </p>
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 border-t border-gray-700 pt-4 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              disabled={submitting}
              className="rounded-md bg-gray-700 px-4 py-2 font-medium text-gray-100 hover:bg-gray-600 disabled:opacity-50"
            >
              Close
            </button>
            {result && (
              <a
                href={result.comfyUiUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-md bg-green-700 px-4 py-2 text-center font-medium text-white hover:bg-green-600"
              >
                Open ComfyUI
              </a>
            )}
            {!result && (
              <button
                type="button"
                onClick={createWorkflow}
                disabled={loading || submitting || !info?.available || !checkpoint}
                className="rounded-md bg-blue-700 px-4 py-2 font-medium text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Copying checkpoint…' : 'Create workflow'}
              </button>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
}
