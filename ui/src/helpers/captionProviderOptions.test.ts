import { describe, expect, it } from 'vitest';
import { getCloudCaptionProviderOptions, type CaptionProviderOptions } from '../../cron/actions/captionProviderOptions';

describe('getCloudCaptionProviderOptions', () => {
  it('does not read or create caption settings for a training process', () => {
    const processConfig = { type: 'diffusion_trainer' };

    expect(getCloudCaptionProviderOptions(processConfig)).toEqual({});
    expect(processConfig).not.toHaveProperty('caption');
  });

  it('initializes missing provider options for a cloud caption process', () => {
    const processConfig: {
      type: string;
      caption: { provider_options?: CaptionProviderOptions };
    } = { type: 'CloudCaptioner', caption: {} };

    const providerOptions = getCloudCaptionProviderOptions(processConfig);

    expect(providerOptions).toBe(processConfig.caption.provider_options);
    expect(providerOptions).toEqual({});
  });

  it('preserves configured cloud caption provider options', () => {
    const configured = { backend: 'vertex', project: 'example-project' };
    const processConfig = {
      type: 'CloudCaptioner',
      caption: { provider_options: configured },
    };

    expect(getCloudCaptionProviderOptions(processConfig)).toBe(configured);
  });
});
