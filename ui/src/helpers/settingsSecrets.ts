export type SecretSource = 'environment' | 'local' | null;

export type PublicSecretStatus = {
  configured: boolean;
  source: SecretSource;
};

export type SecretMutation = { action: 'unchanged' } | { action: 'clear' } | { action: 'set'; value: string };

export const getSecretMutation = (value: unknown, clear: unknown): SecretMutation => {
  if (clear === true) return { action: 'clear' };
  if (typeof value === 'string' && value.trim()) return { action: 'set', value: value.trim() };
  return { action: 'unchanged' };
};

export const buildPublicSettings = (
  rows: Array<{ key: string; value: string }>,
  defaults: { trainingFolder: string; datasetsFolder: string },
  secrets: { hfToken: PublicSecretStatus; geminiApiKey: PublicSecretStatus },
) => {
  const paths = Object.fromEntries(rows.map(row => [row.key, row.value]));
  return {
    TRAINING_FOLDER: paths.TRAINING_FOLDER || defaults.trainingFolder,
    DATASETS_FOLDER: paths.DATASETS_FOLDER || defaults.datasetsFolder,
    HF_TOKEN_CONFIGURED: secrets.hfToken.configured,
    HF_TOKEN_SOURCE: secrets.hfToken.source,
    GEMINI_API_KEY_CONFIGURED: secrets.geminiApiKey.configured,
    GEMINI_API_KEY_SOURCE: secrets.geminiApiKey.source,
  };
};
