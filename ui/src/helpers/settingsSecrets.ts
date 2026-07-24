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
  vertex?: {
    project: string;
    location: string;
    credentialsFile: string;
    projectSource: 'environment' | 'local' | null;
    locationSource: 'environment' | 'local' | 'default';
    credentialsSource: 'environment' | 'local' | null;
    credentialsFileExists: boolean;
  },
) => {
  const paths = Object.fromEntries(rows.map(row => [row.key, row.value]));
  return {
    TRAINING_FOLDER: paths.TRAINING_FOLDER || defaults.trainingFolder,
    DATASETS_FOLDER: paths.DATASETS_FOLDER || defaults.datasetsFolder,
    HF_TOKEN_CONFIGURED: secrets.hfToken.configured,
    HF_TOKEN_SOURCE: secrets.hfToken.source,
    GEMINI_API_KEY_CONFIGURED: secrets.geminiApiKey.configured,
    GEMINI_API_KEY_SOURCE: secrets.geminiApiKey.source,
    GOOGLE_CLOUD_PROJECT: vertex?.project || '',
    GOOGLE_CLOUD_LOCATION: vertex?.location || 'global',
    GOOGLE_APPLICATION_CREDENTIALS: vertex?.credentialsFile || '',
    GOOGLE_CLOUD_PROJECT_SOURCE: vertex?.projectSource || null,
    GOOGLE_CLOUD_LOCATION_SOURCE: vertex?.locationSource || 'default',
    GOOGLE_APPLICATION_CREDENTIALS_SOURCE: vertex?.credentialsSource || null,
    VERTEX_ADC_CONFIGURED: Boolean(vertex?.credentialsFileExists),
    VERTEX_CONFIGURED: Boolean(vertex?.project && vertex?.credentialsFileExists),
  };
};
