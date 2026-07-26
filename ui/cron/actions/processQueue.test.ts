import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startJob: vi.fn(async () => undefined),
  getRunPodConfig: vi.fn(async () => ({ maxConcurrentJobs: 3 })),
  prisma: {
    queue: {
      findMany: vi.fn(),
      update: vi.fn(async () => undefined),
    },
    job: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(async () => undefined),
    },
  },
}));

vi.mock('../prisma', () => ({ default: mocks.prisma }));
vi.mock('./startJob', () => ({ default: mocks.startJob }));
vi.mock('../remote/settings', () => ({
  RUNPOD_QUEUE_KEY: 'runpod:h100',
  getRunPodConfig: mocks.getRunPodConfig,
  safeRunPodConcurrencyLimit: (value: number) => (Number.isSafeInteger(value) && value >= 1 && value <= 3 ? value : 1),
}));

import processQueue from './processQueue';

const remoteQueue = { id: 9, gpu_ids: 'runpod:h100', is_running: true };
const remoteJob = (id: string, queuePosition: number) => ({
  id,
  gpu_ids: 'runpod:h100',
  execution_target: 'runpod_serverless',
  status: 'queued',
  queue_position: queuePosition,
});

describe('RunPod queue concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.queue.findMany.mockResolvedValue([remoteQueue]);
    mocks.getRunPodConfig.mockResolvedValue({ maxConcurrentJobs: 3 });
  });

  it('starts three queued remote jobs when all slots are free', async () => {
    const jobs = [remoteJob('job-1', 1000), remoteJob('job-2', 2000), remoteJob('job-3', 3000)];
    mocks.prisma.job.count.mockResolvedValue(0);
    mocks.prisma.job.findMany.mockResolvedValue(jobs);

    await processQueue();

    expect(mocks.prisma.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 3, orderBy: { queue_position: 'asc' } }),
    );
    expect(mocks.startJob.mock.calls.map(call => call[0])).toEqual(['job-1', 'job-2', 'job-3']);
  });

  it('fills only the remaining slot when two remote jobs are active', async () => {
    mocks.prisma.job.count.mockResolvedValue(2);
    mocks.prisma.job.findMany.mockResolvedValue([remoteJob('job-3', 3000)]);

    await processQueue();

    expect(mocks.prisma.job.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }));
    expect(mocks.startJob).toHaveBeenCalledOnce();
    expect(mocks.startJob).toHaveBeenCalledWith('job-3');
  });

  it('does not dispatch a fourth job while all three slots are occupied', async () => {
    mocks.prisma.job.count.mockResolvedValue(3);

    await processQueue();

    expect(mocks.prisma.job.findMany).not.toHaveBeenCalled();
    expect(mocks.startJob).not.toHaveBeenCalled();
  });

  it('falls back to one slot if the stored limit is invalid', async () => {
    mocks.getRunPodConfig.mockResolvedValue({ maxConcurrentJobs: 99 });
    mocks.prisma.job.count.mockResolvedValue(0);
    mocks.prisma.job.findMany.mockResolvedValue([remoteJob('job-1', 1000)]);

    await processQueue();

    expect(mocks.prisma.job.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }));
    expect(mocks.startJob).toHaveBeenCalledOnce();
  });

  it('keeps local GPU queues serialized', async () => {
    mocks.prisma.queue.findMany.mockResolvedValue([{ id: 2, gpu_ids: '0', is_running: true }]);
    mocks.prisma.job.findFirst.mockResolvedValue({ id: 'local-active', gpu_ids: '0', status: 'running' });

    await processQueue();

    expect(mocks.getRunPodConfig).not.toHaveBeenCalled();
    expect(mocks.prisma.job.count).not.toHaveBeenCalled();
    expect(mocks.startJob).not.toHaveBeenCalled();
  });
});
