import prisma from '../prisma';

import { Job, Queue } from '@prisma/client';
import startJob from './startJob';
import { getRunPodConfig, RUNPOD_QUEUE_KEY, safeRunPodConcurrencyLimit } from '../remote/settings';

export default async function processQueue() {
  const queues: Queue[] = await prisma.queue.findMany({
    orderBy: {
      id: 'asc',
    },
  });

  for (const queue of queues) {
    if (!queue.is_running) {
      // stop any running jobs first
      const runningJobs: Job[] = await prisma.job.findMany({
        where: {
          status: 'running',
          gpu_ids: queue.gpu_ids,
        },
      });

      for (const job of runningJobs) {
        console.log(`Stopping job ${job.id} on GPU(s) ${job.gpu_ids}`);
        await prisma.job.update({
          where: { id: job.id },
          data: {
            return_to_queue: true,
            stop: job.execution_target === 'runpod_serverless' ? true : job.stop,
            status: job.execution_target === 'runpod_serverless' ? 'stopping' : job.status,
            info: 'Stopping job...',
          },
        });
      }
    }
    if (queue.is_running) {
      if (queue.gpu_ids === RUNPOD_QUEUE_KEY) {
        const config = await getRunPodConfig();
        const concurrencyLimit = safeRunPodConcurrencyLimit(config.maxConcurrentJobs);
        const activeJobCount = await prisma.job.count({
          where: {
            execution_target: 'runpod_serverless',
            status: { in: ['running', 'stopping'] },
          },
        });
        const availableSlots = Math.max(0, concurrencyLimit - activeJobCount);
        if (availableSlots === 0) continue;

        const nextJobs: Job[] = await prisma.job.findMany({
          where: {
            status: 'queued',
            execution_target: 'runpod_serverless',
            gpu_ids: RUNPOD_QUEUE_KEY,
          },
          orderBy: { queue_position: 'asc' },
          take: availableSlots,
        });
        for (const [index, nextJob] of nextJobs.entries()) {
          console.log(`Starting remote job ${nextJob.id} (${activeJobCount + index + 1}/${concurrencyLimit})`);
          await startJob(nextJob.id);
        }
        if (activeJobCount === 0 && nextJobs.length === 0) {
          console.log('No more jobs in the RunPod queue, stopping queue');
          await prisma.queue.update({
            where: { id: queue.id },
            data: { is_running: false },
          });
        }
        continue;
      }

      // first see if one is already running, status of running or stopping
      const runningJob: Job | null = await prisma.job.findFirst({
        where: {
          status: { in: ['running', 'stopping'] },
          gpu_ids: queue.gpu_ids,
        },
      });

      if (runningJob) {
        // already running, nothing to do
        continue; // skip to next queue
      } else {
        // find the next job in the queue
        const nextJob: Job | null = await prisma.job.findFirst({
          where: {
            status: 'queued',
            gpu_ids: queue.gpu_ids,
          },
          orderBy: {
            queue_position: 'asc',
          },
        });
        if (nextJob) {
          console.log(`Starting job ${nextJob.id} on GPU(s) ${nextJob.gpu_ids}`);
          await startJob(nextJob.id);
        } else {
          // no more jobs, stop the queue
          console.log(`No more jobs in queue for GPU(s) ${queue.gpu_ids}, stopping queue`);
          await prisma.queue.update({
            where: { id: queue.id },
            data: { is_running: false },
          });
        }
      }
    }
  }
}
