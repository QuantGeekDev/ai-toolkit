import type { ComfyWorkspace } from '@prisma/client';

const iso = (value: Date | null | undefined) => value?.toISOString() || null;
const number = (value: bigint | number | null | undefined) => Number(value || 0);

export const comfyWorkspaceDto = (workspace: ComfyWorkspace) => ({
  id: workspace.id,
  jobId: workspace.job_id,
  state: workspace.state,
  phase: workspace.phase,
  exportMode: workspace.export_mode,
  selectedCheckpoint: workspace.selected_checkpoint,
  preserveOutputs: workspace.preserve_outputs,
  workflowName: workspace.workflow_name,
  checkpointCount: workspace.checkpoint_count,
  requestedGpu: workspace.requested_gpu,
  actualGpu: workspace.actual_gpu,
  containerDiskGb: workspace.container_disk_gb,
  hourlyRate: workspace.hourly_rate,
  estimatedMaxCost: workspace.estimated_max_cost,
  maxRuntimeMinutes: workspace.max_runtime_minutes,
  idleTimeoutMinutes: workspace.idle_timeout_minutes,
  providerStartedAt: iso(workspace.provider_started_at),
  readyAt: iso(workspace.ready_at),
  expiresAt: iso(workspace.expires_at),
  lastUserActivityAt: iso(workspace.last_user_activity_at),
  lastQueueActivityAt: iso(workspace.last_queue_activity_at),
  lastRemoteContactAt: iso(workspace.last_remote_contact_at),
  bytesPlanned: number(workspace.bytes_planned),
  bytesTransferred: number(workspace.bytes_transferred),
  idleGraceStartedAt: (() => {
    try {
      return JSON.parse(workspace.remote_status_json || '{}')?.idleGraceStartedAt || null;
    } catch {
      return null;
    }
  })(),
  outputSyncState: workspace.output_sync_state,
  outputSyncError: workspace.output_sync_error,
  terminationMode: workspace.termination_mode,
  terminationReason: workspace.termination_reason,
  terminationRequestedAt: iso(workspace.termination_requested_at),
  terminatedAt: iso(workspace.terminated_at),
  errorCode: workspace.error_code,
  errorMessage: workspace.error_message,
  createdAt: iso(workspace.created_at),
  updatedAt: iso(workspace.updated_at),
});
