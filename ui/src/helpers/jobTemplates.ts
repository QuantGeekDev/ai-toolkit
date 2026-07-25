import type { JobConfig } from '../types';

export const JOB_TEMPLATE_SCHEMA_VERSION = 1;

export interface JobTemplate {
  schema_version: typeof JOB_TEMPLATE_SCHEMA_VERSION;
  label: string;
  description?: string;
  family?: string;
  gpu_ids: string | null;
  job_config: JobConfig;
}

export interface JobTemplateSummary {
  id: string;
  label: string;
  description?: string;
  family?: string;
  gpu_ids: string | null;
}

export interface JobTemplateIssue {
  id: string;
  error: string;
}

export interface JobTemplateCatalog {
  schema_version: typeof JOB_TEMPLATE_SCHEMA_VERSION;
  default_template: string | null;
  templates: JobTemplateSummary[];
  issues: JobTemplateIssue[];
}

export interface JobTemplateIndex {
  schema_version: typeof JOB_TEMPLATE_SCHEMA_VERSION;
  default_template: string | null;
}

const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  return normalized || undefined;
};

export const isSafeJobTemplateId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 120 && TEMPLATE_ID_PATTERN.test(value);

export const normalizeJobTemplateId = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 120);

export const validateJobTemplate = (value: unknown): JobTemplate => {
  if (!isRecord(value)) throw new Error('Template must be a JSON object');
  if (value.schema_version !== JOB_TEMPLATE_SCHEMA_VERSION) {
    throw new Error(`schema_version must be ${JOB_TEMPLATE_SCHEMA_VERSION}`);
  }

  const label = optionalString(value.label, 'label');
  if (!label) throw new Error('label is required');
  const description = optionalString(value.description, 'description');
  const family = optionalString(value.family, 'family');

  if (value.gpu_ids !== null && typeof value.gpu_ids !== 'string') {
    throw new Error('gpu_ids must be a string or null');
  }

  const jobConfig = value.job_config;
  if (!isRecord(jobConfig) || typeof jobConfig.job !== 'string') {
    throw new Error('job_config.job must be a string');
  }
  if (!isRecord(jobConfig.config) || typeof jobConfig.config.name !== 'string') {
    throw new Error('job_config.config.name must be a string');
  }
  if (!Array.isArray(jobConfig.config.process) || jobConfig.config.process.length === 0) {
    throw new Error('job_config.config.process must contain at least one process');
  }
  if (!isRecord(jobConfig.config.process[0])) {
    throw new Error('job_config.config.process[0] must be an object');
  }
  if (!isRecord(jobConfig.meta)) {
    throw new Error('job_config.meta must be an object');
  }

  return {
    schema_version: JOB_TEMPLATE_SCHEMA_VERSION,
    label,
    ...(description ? { description } : {}),
    ...(family ? { family } : {}),
    gpu_ids: value.gpu_ids as string | null,
    job_config: jobConfig as unknown as JobConfig,
  };
};

export const validateJobTemplateIndex = (value: unknown): JobTemplateIndex => {
  if (!isRecord(value)) throw new Error('Template index must be a JSON object');
  if (value.schema_version !== JOB_TEMPLATE_SCHEMA_VERSION) {
    throw new Error(`schema_version must be ${JOB_TEMPLATE_SCHEMA_VERSION}`);
  }
  if (value.default_template !== null && !isSafeJobTemplateId(value.default_template)) {
    throw new Error('default_template must be a safe template ID or null');
  }
  return {
    schema_version: JOB_TEMPLATE_SCHEMA_VERSION,
    default_template: value.default_template as string | null,
  };
};

export const summarizeJobTemplate = (id: string, template: JobTemplate): JobTemplateSummary => ({
  id,
  label: template.label,
  ...(template.description ? { description: template.description } : {}),
  ...(template.family ? { family: template.family } : {}),
  gpu_ids: template.gpu_ids,
});

export const snapshotJobTemplateState = (jobConfig: JobConfig, gpuIds: string | null): string =>
  JSON.stringify({ gpu_ids: gpuIds, job_config: jobConfig });
