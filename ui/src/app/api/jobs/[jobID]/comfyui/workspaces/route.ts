import { randomUUID } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import prisma from '@/server/prisma';
import { getTrainingFolder } from '@/server/settings';
import { isKrea2JobConfig, listKrea2Checkpoints } from '@/server/comfyuiExport';
import { comfyWorkspaceDto } from '../../../../../../../cron/comfy/dto';
import {
  COMFY_DURATION_CHOICES,
  getRunPodComfyConfig,
  validateRunPodComfyConfig,
  type ComfyDurationHours,
} from '../../../../../../../cron/comfy/settings';

type CreateBody = {
  requestKey?: unknown;
  mode?: unknown;
  checkpoint?: unknown;
  maxHours?: unknown;
  preserveOutputs?: unknown;
};

const responseError = (message: string, status: number, code: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error: message, code, ...extra }, { status });

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobID: string }> }) {
  const { jobID } = await params;
  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return responseError('Request body must be valid JSON.', 400, 'INVALID_REQUEST');
  }
  const requestKey = typeof body.requestKey === 'string' ? body.requestKey.trim() : '';
  const mode = body.mode == null ? 'comparison' : body.mode;
  const checkpoint = typeof body.checkpoint === 'string' ? body.checkpoint : null;
  const maxHours = Number(body.maxHours);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestKey)) {
    return responseError('requestKey must be an 8-128 character idempotency key.', 400, 'INVALID_REQUEST_KEY');
  }
  if (mode !== 'comparison' && mode !== 'single') {
    return responseError('mode must be comparison or single.', 422, 'INVALID_EXPORT_MODE');
  }
  if (!COMFY_DURATION_CHOICES.includes(maxHours as ComfyDurationHours)) {
    return responseError('maxHours must be 1, 2, 4, or 8.', 422, 'INVALID_DURATION');
  }
  if (typeof body.preserveOutputs !== 'boolean') {
    return responseError('preserveOutputs must be a boolean.', 400, 'INVALID_REQUEST');
  }

  const existingRequest = await prisma.comfyWorkspace.findUnique({ where: { request_key: requestKey } });
  if (existingRequest) {
    if (existingRequest.job_id !== jobID) {
      return responseError('This request key is already associated with another job.', 409, 'REQUEST_KEY_CONFLICT');
    }
    return NextResponse.json({ workspace: comfyWorkspaceDto(existingRequest) }, { status: 202 });
  }

  const config = await getRunPodComfyConfig();
  const configurationErrors = validateRunPodComfyConfig(config);
  if (configurationErrors.length) {
    return responseError(configurationErrors[0], 503, 'COMFY_DISABLED', { configurationErrors });
  }
  if (!config.allowedMaxHours.includes(maxHours as ComfyDurationHours)) {
    return responseError('The requested duration is not enabled by the operator.', 422, 'INVALID_DURATION');
  }

  const job = await prisma.job.findUnique({ where: { id: jobID } });
  if (!job) return responseError('Job not found.', 404, 'JOB_NOT_FOUND');
  if (job.job_type !== 'train' || !isKrea2JobConfig(job.job_config)) {
    return responseError('Only Krea 2 training jobs can use a temporary H100 workspace.', 422, 'UNSUPPORTED_JOB');
  }
  const checkpoints = await listKrea2Checkpoints(await getTrainingFolder(), job.name, job.step);
  if (!checkpoints.length)
    return responseError('This job has no saved safetensors checkpoints.', 422, 'NO_CHECKPOINTS');
  if (mode === 'single' && !checkpoints.some(item => item.fileName === checkpoint)) {
    return responseError('The selected checkpoint is not available.', 422, 'CHECKPOINT_NOT_FOUND');
  }

  const id = randomUUID();
  try {
    const workspace = await prisma.comfyWorkspace.create({
      data: {
        id,
        job_id: job.id,
        request_key: requestKey,
        managed_pod_name: `aitk-comfy-${id}`,
        active_lease_key: 'global',
        state: 'requested',
        phase: 'queued_for_preparation',
        export_mode: mode,
        selected_checkpoint: mode === 'single' ? checkpoint : null,
        preserve_outputs: body.preserveOutputs,
        requested_gpu: config.gpuIds[0],
        container_disk_gb: config.minContainerDiskGb,
        max_runtime_minutes: maxHours * 60,
        idle_timeout_minutes: config.idleMinutes,
        output_sync_state: body.preserveOutputs ? 'pending' : 'disabled',
      },
    });
    return NextResponse.json({ workspace: comfyWorkspaceDto(workspace) }, { status: 202 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const byRequest = await prisma.comfyWorkspace.findUnique({ where: { request_key: requestKey } });
      if (byRequest) return NextResponse.json({ workspace: comfyWorkspaceDto(byRequest) }, { status: 202 });
      const active = await prisma.comfyWorkspace.findFirst({ where: { active_lease_key: 'global' } });
      if (active) {
        return responseError('Another temporary ComfyUI workspace is active.', 409, 'WORKSPACE_LIMIT', {
          workspace: comfyWorkspaceDto(active),
        });
      }
    }
    console.error('Could not create ComfyUI workspace request:', error);
    return responseError('Could not create the workspace request.', 500, 'WORKSPACE_CREATE_FAILED');
  }
}
