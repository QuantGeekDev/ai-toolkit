import { describe, expect, it } from 'vitest';
import { CLOUD_QUEUE_KEY, getCaptionQueueKey, isCloudCaptionJob } from './captionExecution';

const config = (type: string) => ({ config: { process: [{ type }] } });

describe('caption execution target', () => {
  it('routes cloud captioners to the reserved cloud queue', () => {
    expect(isCloudCaptionJob(config('CloudCaptioner'))).toBe(true);
    expect(getCaptionQueueKey(config('CloudCaptioner'), '0')).toBe(CLOUD_QUEUE_KEY);
  });

  it('preserves the selected GPU for local captioners', () => {
    expect(isCloudCaptionJob(config('Qwen3VLCaptioner'))).toBe(false);
    expect(getCaptionQueueKey(config('Qwen3VLCaptioner'), '2')).toBe('2');
  });

  it('never serializes null as a queue key', () => {
    expect(getCaptionQueueKey(config('Qwen3VLCaptioner'), null)).toBe('');
  });
});
