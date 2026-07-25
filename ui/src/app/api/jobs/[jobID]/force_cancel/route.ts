import { NextResponse } from 'next/server';
import prisma from '@/server/prisma';
import { RunPodClient } from '../../../../../../cron/remote/runpodClient';
import { getRunPodConfig, validateRunPodConfig } from '../../../../../../cron/remote/settings';

export async function POST(_request: Request, { params }: { params: Promise<{ jobID: string }> }) {
  const { jobID } = await params;
  const job = await prisma.job.findUnique({ where: { id: jobID } });
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (job.execution_target !== 'runpod_serverless') {
    return NextResponse.json({ error: 'This is not a remote job.' }, { status: 409 });
  }
  const execution = await prisma.remoteExecution.findFirst({
    where: { job_id: jobID, state: { in: ['queued', 'running', 'stop_requested', 'submission_unknown'] } },
    orderBy: { attempt: 'desc' },
  });
  if (!execution) return NextResponse.json({ error: 'No active remote execution.' }, { status: 409 });
  if (execution.error_code === 'FORCE_CANCEL_REQUESTED') {
    return NextResponse.json({ ok: true, executionId: execution.id, status: 'already_requested' }, { status: 202 });
  }
  const config = await getRunPodConfig();
  const errors = validateRunPodConfig(config);
  if (errors.length) return NextResponse.json({ error: errors.join(' ') }, { status: 503 });
  const now = new Date();
  await prisma.remoteExecution.update({
    where: { id: execution.id },
    data: {
      state: 'stop_requested',
      phase: 'force_cancel_requested',
      stop_requested_at: execution.stop_requested_at || now,
      error_code: 'FORCE_CANCEL_REQUESTED',
      error_message: 'A one-shot provider cancellation was requested; awaiting durable terminal state.',
    },
  });
  if (execution.provider_job_id) {
    try {
      await new RunPodClient(config).cancel(execution.provider_job_id);
    } catch (error: any) {
      return NextResponse.json(
        { ok: true, executionId: execution.id, status: 'acknowledgement_unknown', warning: error?.message },
        { status: 202 },
      );
    }
  }
  await prisma.$transaction([
    prisma.remoteExecution.update({
      where: { id: execution.id },
      data: {
        state: 'stopped',
        phase: 'force_cancelled',
        stop_requested_at: execution.stop_requested_at || now,
        finished_at: now,
        artifact_sync_state: 'partial',
        error_code: 'FORCE_CANCELLED',
        error_message: 'Execution was force-cancelled; only artifacts already mirrored locally are trusted.',
      },
    }),
    prisma.job.update({
      where: { id: jobID },
      data: {
        status: 'stopped',
        stop: false,
        pid: null,
        info: 'Remote execution force-cancelled; artifacts may be incomplete.',
      },
    }),
  ]);
  return NextResponse.json({ ok: true, executionId: execution.id });
}
