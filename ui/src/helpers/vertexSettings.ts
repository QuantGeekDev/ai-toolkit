import path from 'path';
import fs from 'fs';

export type VertexSettingsInput = {
  GOOGLE_CLOUD_PROJECT?: unknown;
  GOOGLE_CLOUD_LOCATION?: unknown;
  GOOGLE_APPLICATION_CREDENTIALS?: unknown;
};

export type NormalizedVertexSettings = {
  GOOGLE_CLOUD_PROJECT?: string;
  GOOGLE_CLOUD_LOCATION?: string;
  GOOGLE_APPLICATION_CREDENTIALS?: string;
};

export const normalizeVertexSettings = (input: VertexSettingsInput): NormalizedVertexSettings => {
  const normalized: NormalizedVertexSettings = {};

  if (typeof input.GOOGLE_CLOUD_PROJECT === 'string') {
    const project = input.GOOGLE_CLOUD_PROJECT.trim();
    if (project && !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) {
      throw new Error('Vertex AI project must be a valid Google Cloud project ID.');
    }
    normalized.GOOGLE_CLOUD_PROJECT = project;
  }

  if (typeof input.GOOGLE_CLOUD_LOCATION === 'string') {
    const location = input.GOOGLE_CLOUD_LOCATION.trim().toLowerCase();
    if (location && !/^[a-z0-9-]{1,63}$/.test(location)) {
      throw new Error('Vertex AI location must contain only lowercase letters, numbers, and hyphens.');
    }
    normalized.GOOGLE_CLOUD_LOCATION = location;
  }

  if (typeof input.GOOGLE_APPLICATION_CREDENTIALS === 'string') {
    const credentialsFile = input.GOOGLE_APPLICATION_CREDENTIALS.trim();
    if (credentialsFile && (!path.isAbsolute(credentialsFile) || !credentialsFile.toLowerCase().endsWith('.json'))) {
      throw new Error('ADC credentials must be an absolute path to a JSON file.');
    }
    if (credentialsFile.length > 2048) {
      throw new Error('ADC credentials path is too long.');
    }
    normalized.GOOGLE_APPLICATION_CREDENTIALS = credentialsFile;
  }

  return normalized;
};

export const normalizeGeminiBackend = (value: unknown): 'developer' | 'vertex' => {
  const backend = String(value || 'developer')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (['developer', 'developer_api', 'gemini_api'].includes(backend)) return 'developer';
  if (['vertex', 'vertex_ai', 'enterprise'].includes(backend)) return 'vertex';
  throw new Error('Gemini backend must be developer or vertex.');
};

export const readADCQuotaProject = (credentialsFile: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
  } catch {
    throw new Error('ADC credentials file is not valid readable JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || !('quota_project_id' in parsed)) return null;
  const quotaProject = String(parsed.quota_project_id || '').trim();
  return quotaProject || null;
};
