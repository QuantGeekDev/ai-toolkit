import { describe, expect, it } from 'vitest';
import { buildPublicSettings, getSecretMutation } from './settingsSecrets';

describe('secret-safe settings helpers', () => {
  it('returns status metadata without returning stored secret rows', () => {
    const publicSettings = buildPublicSettings(
      [
        { key: 'TRAINING_FOLDER', value: 'C:/train' },
        { key: 'GEMINI_API_KEY', value: 'canary-secret' },
      ],
      { trainingFolder: 'default-train', datasetsFolder: 'default-data' },
      {
        hfToken: { configured: false, source: null },
        geminiApiKey: { configured: true, source: 'local' },
      },
    );
    expect(JSON.stringify(publicSettings)).not.toContain('canary-secret');
    expect(publicSettings.GEMINI_API_KEY_CONFIGURED).toBe(true);
    expect(publicSettings.DATASETS_FOLDER).toBe('default-data');
  });

  it('distinguishes unchanged, set, and explicit clear', () => {
    expect(getSecretMutation('', false)).toEqual({ action: 'unchanged' });
    expect(getSecretMutation(undefined, false)).toEqual({ action: 'unchanged' });
    expect(getSecretMutation('  new-key  ', false)).toEqual({ action: 'set', value: 'new-key' });
    expect(getSecretMutation('ignored', true)).toEqual({ action: 'clear' });
  });
});
