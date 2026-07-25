import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/server/prisma';

export async function GET(request: NextRequest, { params }: { params: { jobID: string } }) {
  const { jobID } = await params;

  const job = await prisma.job.findUnique({
    where: { id: jobID },
  });

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  if (job.execution_target === 'runpod_serverless' && process.env.AI_TOOLKIT_RUNPOD_ENABLED !== '1') {
    return NextResponse.json({ error: 'RunPod training is disabled on this AI Toolkit server.' }, { status: 409 });
  }
  const gpuIds = job.execution_target === 'runpod_serverless' ? 'runpod:h100' : job.gpu_ids;
  if (gpuIds !== job.gpu_ids) {
    await prisma.job.update({ where: { id: job.id }, data: { gpu_ids: gpuIds } });
  }

  // get highest queue position
  const highestQueuePosition = await prisma.job.aggregate({
    _max: {
      queue_position: true,
    },
  });
  const newQueuePosition = (highestQueuePosition._max.queue_position || 0) + 1000;

  await prisma.job.update({
    where: { id: jobID },
    data: { queue_position: newQueuePosition },
  });

  // make sure the queue is running
  const queue = await prisma.queue.findFirst({
    where: {
      gpu_ids: gpuIds,
    },
  });

  // if queue doesn't exist, create it
  if (!queue) {
    await prisma.queue.create({
      data: {
        gpu_ids: gpuIds,
        is_running: false,
      },
    });
  }

  await prisma.job.update({
    where: { id: jobID },
    data: {
      status: 'queued',
      stop: false,
      return_to_queue: false,
      info: 'Job queued',
    },
  });

  // Return the response immediately
  return NextResponse.json(job);
}
