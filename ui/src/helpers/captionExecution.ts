export const CLOUD_QUEUE_KEY = 'cloud';

export const isCloudCaptionJob = (jobConfig: any): boolean => {
  return jobConfig?.config?.process?.[0]?.type === 'CloudCaptioner';
};

export const getCaptionQueueKey = (jobConfig: any, gpuIDs: string | null | undefined): string => {
  return isCloudCaptionJob(jobConfig) ? CLOUD_QUEUE_KEY : gpuIDs || '';
};
