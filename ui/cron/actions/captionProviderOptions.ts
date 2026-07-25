export type CaptionProviderOptions = {
  backend?: string;
  project?: string;
  location?: string;
  [key: string]: unknown;
};

type ProcessConfig = {
  type?: unknown;
  caption?: {
    provider_options?: CaptionProviderOptions;
  };
};

export const getCloudCaptionProviderOptions = (processConfig: ProcessConfig): CaptionProviderOptions => {
  if (processConfig.type !== 'CloudCaptioner' || !processConfig.caption) return {};

  const providerOptions = processConfig.caption.provider_options;
  if (providerOptions && typeof providerOptions === 'object' && !Array.isArray(providerOptions)) {
    return providerOptions;
  }

  processConfig.caption.provider_options = {};
  return processConfig.caption.provider_options;
};
