import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/server/prisma';

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobID: string }> }) {
  const { jobID } = await params;
  const job = await prisma.job.findUnique({ where: { id: jobID } });
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (process.env.AI_TOOLKIT_RUNPOD_ENABLED !== '1' || job.execution_target !== 'runpod_serverless') {
    return NextResponse.json({ error: 'Remote continuation is unavailable.' }, { status: 409 });
  }
  if (!['completed', 'stopped'].includes(job.status)) {
    return NextResponse.json({ error: 'Only a completed or safely stopped job can be continued.' }, { status: 409 });
  }
  const previous = await prisma.remoteExecution.findFirst({
    where: { job_id: jobID, state: { in: ['completed', 'stopped'] }, artifact_sync_state: 'complete' },
    orderBy: { attempt: 'desc' },
  });
  if (!previous)
    return NextResponse.json({ error: 'No verified remote attempt is available to resume.' }, { status: 409 });
  const body = await request.json().catch(() => ({}));
  const additionalSteps = Math.trunc(Number(body.additionalSteps ?? 500));
  if (!Number.isSafeInteger(additionalSteps) || additionalSteps < 1 || additionalSteps > 100_000) {
    return NextResponse.json({ error: 'additionalSteps must be an integer from 1 to 100000.' }, { status: 400 });
  }
  let config: any;
  try {
    config = JSON.parse(job.job_config);
    if (!config?.config?.process?.[0]?.train) throw new Error('missing train config');
  } catch {
    return NextResponse.json({ error: 'Job configuration is invalid.' }, { status: 422 });
  }
  const targetSteps = job.step + additionalSteps;
  config.config.process[0].train.steps = targetSteps;
  const highest = await prisma.job.aggregate({ _max: { queue_position: true } });
  await prisma.$transaction([
    prisma.queue.upsert({
      where: { gpu_ids: 'runpod:h100' },
      update: { is_running: true },
      create: { gpu_ids: 'runpod:h100', is_running: true },
    }),
    prisma.job.update({
      where: { id: jobID },
      data: {
        job_config: JSON.stringify(config),
        total_steps: targetSteps,
        gpu_ids: 'runpod:h100',
        status: 'queued',
        stop: false,
        return_to_queue: false,
        info: `Queued remote continuation from step ${job.step} to ${targetSteps}.`,
        queue_position: (highest._max.queue_position || 0) + 1000,
      },
    }),
  ]);
  return NextResponse.json({ ok: true, fromStep: job.step, targetSteps, parentExecutionId: previous.id });
}
