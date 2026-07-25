import { NextResponse } from 'next/server';
import prisma from '@/server/prisma';
import { isMac } from '@/helpers/basic';
import { cached } from '@/server/apiCache';
import { CLOUD_QUEUE_KEY, isCloudCaptionJob } from '@/helpers/captionExecution';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const job_ref = searchParams.get('job_ref');
  const job_type = searchParams.get('job_type');
  const only_active = searchParams.get('only_active');

  try {
    if (id) {
      const job = await prisma.job.findUnique({
        where: { id },
      });
      return NextResponse.json(job);
    }
    if (job_ref) {
      const job = await prisma.job.findFirst({
        where: { job_ref },
        orderBy: { updated_at: 'desc' },
      });
      return NextResponse.json(job);
    }

    const where: any = {};
    if (job_type) {
      where.job_type = job_type;
    }
    if (only_active === 'true') {
      where.status = { in: ['running', 'queued', 'stopping'] };
      const jobs = await cached(
        'jobs-active',
        () =>
          prisma.job.findMany({
            where,
            orderBy: { created_at: 'desc' },
          }),
        5000,
        { job_type },
      );
      return NextResponse.json({ jobs: jobs });
    }

    const jobs = await prisma.job.findMany({
      where,
      orderBy: { created_at: 'desc' },
    });
    return NextResponse.json({ jobs: jobs });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to fetch training data' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { id, name, job_config } = body;
    const executionTarget = String(body.execution_target || 'local');
    if (!['local', 'runpod_serverless'].includes(executionTarget)) {
      return NextResponse.json({ error: 'Invalid execution target.' }, { status: 400 });
    }
    let gpu_ids: string = body.gpu_ids;
    const isCloudCaptioner = isCloudCaptionJob(job_config);

    if (isCloudCaptioner) {
      if (executionTarget !== 'local') {
        return NextResponse.json(
          { error: 'Cloud caption jobs run locally and cannot use the RunPod training queue.' },
          { status: 400 },
        );
      }
      gpu_ids = CLOUD_QUEUE_KEY;
    } else if ([CLOUD_QUEUE_KEY, 'runpod:h100'].includes(gpu_ids)) {
      return NextResponse.json({ error: 'Select a local GPU for local training jobs.' }, { status: 400 });
    }

    if (executionTarget === 'runpod_serverless') {
      if (process.env.AI_TOOLKIT_RUNPOD_ENABLED !== '1') {
        return NextResponse.json({ error: 'RunPod training is disabled on this AI Toolkit server.' }, { status: 403 });
      }
      if (job_config?.config?.process?.[0]?.type !== 'diffusion_trainer') {
        return NextResponse.json({ error: 'Only diffusion trainer jobs can run on RunPod.' }, { status: 400 });
      }
      const trainingSeed = job_config?.config?.process?.[0]?.training_seed;
      if (!Number.isSafeInteger(trainingSeed)) {
        return NextResponse.json({ error: 'Remote training requires an integer training seed.' }, { status: 400 });
      }
      gpu_ids = 'runpod:h100';
    }

    if (isMac() && !isCloudCaptioner && executionTarget === 'local') {
      gpu_ids = 'mps';
    }

    const extra: any = {};
    if ('job_ref' in body) {
      extra['job_ref'] = body.job_ref;
    }

    if ('job_type' in body) {
      extra['job_type'] = body.job_type;
    }

    if (id) {
      const existing = await prisma.job.findUnique({ where: { id } });
      if (!existing) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
      if (['queued', 'running', 'stopping'].includes(existing.status)) {
        return NextResponse.json({ error: 'Stop the active job before editing its configuration.' }, { status: 409 });
      }
      // Update existing training
      const training = await prisma.job.update({
        where: { id },
        data: {
          name,
          gpu_ids,
          execution_target: executionTarget,
          job_config: JSON.stringify(job_config),
          ...extra,
        },
      });
      return NextResponse.json(training);
    } else {
      // find the highest queue position and add 1000
      const highestQueuePosition = await prisma.job.aggregate({
        _max: {
          queue_position: true,
        },
      });
      const newQueuePosition = (highestQueuePosition._max.queue_position || 0) + 1000;

      // Create new training
      const training = await prisma.job.create({
        data: {
          name,
          gpu_ids,
          execution_target: executionTarget,
          job_config: JSON.stringify(job_config),
          queue_position: newQueuePosition,
          ...extra,
        },
      });
      return NextResponse.json(training);
    }
  } catch (error: any) {
    if (error.code === 'P2002') {
      // Handle unique constraint violation, 409=Conflict
      return NextResponse.json({ error: 'Job name already exists' }, { status: 409 });
    }
    console.error(error);
    // Handle other errors
    return NextResponse.json({ error: 'Failed to save training data' }, { status: 500 });
  }
}
