import { describe, expect, it } from 'vitest';
import {
  captionPromptTemplates,
  detectCaptionPromptTemplate,
  getCaptionPromptTemplate,
} from './captionPromptTemplates';

describe('caption prompt templates', () => {
  it('provides Krea 2 identity and character presets', () => {
    expect(captionPromptTemplates.krea2_identity.label).toContain('Identity');
    expect(captionPromptTemplates.krea2_character.label).toContain('Character');
    expect(captionPromptTemplates.krea2_character_outfit.label).toContain('canonical outfit');
  });

  it('keeps one literal trigger instruction and rejects Ideogram-style output', () => {
    for (const id of ['krea2_identity', 'krea2_character', 'krea2_character_outfit']) {
      const prompt = captionPromptTemplates[id].prompt;
      expect(prompt).toContain('Preserve the literal token [trigger] exactly.');
      expect(prompt).toContain('Do not output JSON');
      expect(prompt).toContain('bounding boxes');
    }
  });

  it('detects canonical prompts and treats edits as custom', () => {
    const prompt = captionPromptTemplates.krea2_identity.prompt;
    expect(detectCaptionPromptTemplate(prompt)).toBe('krea2_identity');
    expect(detectCaptionPromptTemplate(`${prompt} Extra instruction.`)).toBe('custom');
    expect(getCaptionPromptTemplate('custom')).toBeUndefined();
  });
});
