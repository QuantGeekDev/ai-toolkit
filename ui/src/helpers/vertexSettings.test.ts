import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizeGeminiBackend, normalizeVertexSettings, readADCQuotaProject } from './vertexSettings';

describe('Vertex settings validation', () => {
  it('normalizes valid project, location, and ADC path values', () => {
    expect(
      normalizeVertexSettings({
        GOOGLE_CLOUD_PROJECT: ' billing-project-123 ',
        GOOGLE_CLOUD_LOCATION: ' GLOBAL ',
        GOOGLE_APPLICATION_CREDENTIALS: 'C:\\gcloud\\adc.json',
      }),
    ).toEqual({
      GOOGLE_CLOUD_PROJECT: 'billing-project-123',
      GOOGLE_CLOUD_LOCATION: 'global',
      GOOGLE_APPLICATION_CREDENTIALS: 'C:\\gcloud\\adc.json',
    });
  });

  it('rejects malformed projects, locations, and relative credential paths', () => {
    expect(() => normalizeVertexSettings({ GOOGLE_CLOUD_PROJECT: 'Not a project' })).toThrow('project ID');
    expect(() => normalizeVertexSettings({ GOOGLE_CLOUD_LOCATION: 'EU WEST' })).toThrow('location');
    expect(() => normalizeVertexSettings({ GOOGLE_APPLICATION_CREDENTIALS: 'adc.json' })).toThrow('absolute path');
  });

  it('normalizes backend aliases and rejects unknown backends', () => {
    expect(normalizeGeminiBackend('gemini-api')).toBe('developer');
    expect(normalizeGeminiBackend('enterprise')).toBe('vertex');
    expect(() => normalizeGeminiBackend('unknown')).toThrow('backend');
  });

  it('reads only the ADC quota project needed for billing-route validation', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'aitk-vertex-test-'));
    const adcPath = path.join(folder, 'adc.json');
    try {
      fs.writeFileSync(
        adcPath,
        JSON.stringify({ type: 'authorized_user', refresh_token: 'secret', quota_project_id: 'billing-project-123' }),
      );
      expect(readADCQuotaProject(adcPath)).toBe('billing-project-123');
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
