import templateData from '../../../extensions_built_in/captioner/prompts/caption_prompt_templates.json';

export interface CaptionPromptTemplate {
  label: string;
  description: string;
  prompt: string;
}

export const captionPromptTemplates = templateData as Record<string, CaptionPromptTemplate>;

export const captionPromptTemplateOptions = [
  { value: 'custom', label: 'Custom prompt' },
  ...Object.entries(captionPromptTemplates).map(([value, template]) => ({
    value,
    label: template.label,
  })),
];

export const getCaptionPromptTemplate = (templateId: string | undefined): CaptionPromptTemplate | undefined => {
  if (!templateId || templateId === 'custom') return undefined;
  return captionPromptTemplates[templateId];
};

export const detectCaptionPromptTemplate = (prompt: string | undefined): string => {
  const normalizedPrompt = prompt?.trim() || '';
  const match = Object.entries(captionPromptTemplates).find(
    ([, template]) => template.prompt.trim() === normalizedPrompt,
  );
  return match?.[0] || 'custom';
};
