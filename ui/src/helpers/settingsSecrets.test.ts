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
      {
        project: 'billing-project-123',
        location: 'global',
        credentialsFile: 'C:/adc.json',
        projectSource: 'local',
        locationSource: 'local',
        credentialsSource: 'local',
        credentialsFileExists: true,
      },
    );
    expect(JSON.stringify(publicSettings)).not.toContain('canary-secret');
    expect(publicSettings.GEMINI_API_KEY_CONFIGURED).toBe(true);
    expect(publicSettings.DATASETS_FOLDER).toBe('default-data');
    expect(publicSettings.VERTEX_CONFIGURED).toBe(true);
    expect(publicSettings.GOOGLE_CLOUD_PROJECT).toBe('billing-project-123');
  });

  it('distinguishes unchanged, set, and explicit clear', () => {
    expect(getSecretMutation('', false)).toEqual({ action: 'unchanged' });
    expect(getSecretMutation(undefined, false)).toEqual({ action: 'unchanged' });
    expect(getSecretMutation('  new-key  ', false)).toEqual({ action: 'set', value: 'new-key' });
    expect(getSecretMutation('ignored', true)).toEqual({ action: 'clear' });
  });
});
