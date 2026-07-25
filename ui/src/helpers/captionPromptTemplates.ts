import templateData from '../../../extensions_built_in/captioner/prompts/caption_prompt_templates.json';

export const CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION = 1;

export interface CaptionPromptTemplate {
  schema_version: typeof CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION;
  label: string;
  description?: string;
  family?: string;
  prompt: string;
}

export interface CaptionPromptTemplateEntry extends CaptionPromptTemplate {
  id: string;
}

export interface CaptionPromptTemplateIssue {
  id: string;
  error: string;
}

export interface CaptionPromptTemplateCatalog {
  schema_version: typeof CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION;
  default_template: string | null;
  templates: CaptionPromptTemplateEntry[];
  issues: CaptionPromptTemplateIssue[];
}

export interface CaptionPromptTemplateIndex {
  schema_version: typeof CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION;
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

export const isSafeCaptionPromptTemplateId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 120 && TEMPLATE_ID_PATTERN.test(value);

export const normalizeCaptionPromptTemplateId = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 120);

export const validateCaptionPromptTemplate = (value: unknown): CaptionPromptTemplate => {
  if (!isRecord(value)) throw new Error('Caption prompt template must be a JSON object');
  if (value.schema_version !== CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION) {
    throw new Error(`schema_version must be ${CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION}`);
  }

  const label = optionalString(value.label, 'label');
  if (!label) throw new Error('label is required');
  const prompt = optionalString(value.prompt, 'prompt');
  if (!prompt) throw new Error('prompt is required');
  const description = optionalString(value.description, 'description');
  const family = optionalString(value.family, 'family');

  return {
    schema_version: CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION,
    label,
    ...(description ? { description } : {}),
    ...(family ? { family } : {}),
    prompt,
  };
};

export const validateCaptionPromptTemplateIndex = (value: unknown): CaptionPromptTemplateIndex => {
  if (!isRecord(value)) throw new Error('Caption prompt template index must be a JSON object');
  if (value.schema_version !== CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION) {
    throw new Error(`schema_version must be ${CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION}`);
  }
  if (value.default_template !== null && !isSafeCaptionPromptTemplateId(value.default_template)) {
    throw new Error('default_template must be a safe template ID or null');
  }
  return {
    schema_version: CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION,
    default_template: value.default_template as string | null,
  };
};

type BundledTemplate = { label: string; description: string; prompt: string };

export const captionPromptTemplates = Object.fromEntries(
  Object.entries(templateData as Record<string, BundledTemplate>).map(([id, template]) => [
    id,
    {
      schema_version: CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION,
      ...template,
    } satisfies CaptionPromptTemplate,
  ]),
) as Record<string, CaptionPromptTemplate>;

export const bundledCaptionPromptTemplateCatalog: CaptionPromptTemplateCatalog = {
  schema_version: CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION,
  default_template: 'general',
  templates: Object.entries(captionPromptTemplates).map(([id, template]) => ({ id, ...template })),
  issues: [],
};

export const captionPromptTemplateOptions = [
  { value: 'custom', label: 'Custom prompt' },
  ...bundledCaptionPromptTemplateCatalog.templates.map(template => ({
    value: template.id,
    label: template.label,
  })),
];

export const getCaptionPromptTemplate = (
  templateId: string | undefined,
  templates: CaptionPromptTemplateEntry[] = bundledCaptionPromptTemplateCatalog.templates,
): CaptionPromptTemplateEntry | undefined => {
  if (!templateId || templateId === 'custom') return undefined;
  return templates.find(template => template.id === templateId);
};

export const detectCaptionPromptTemplate = (
  prompt: string | undefined,
  templates: CaptionPromptTemplateEntry[] = bundledCaptionPromptTemplateCatalog.templates,
): string => {
  const normalizedPrompt = prompt?.trim() || '';
  const match = templates.find(template => template.prompt.trim() === normalizedPrompt);
  return match?.id || 'custom';
};
