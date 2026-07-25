import { describe, expect, it } from 'vitest';
import {
  JOB_TEMPLATE_SCHEMA_VERSION,
  isSafeJobTemplateId,
  normalizeJobTemplateId,
  validateJobTemplate,
} from './jobTemplates';

describe('job template helpers', () => {
  it('normalizes labels into safe versionable IDs', () => {
    expect(normalizeJobTemplateId(' Krea 2 Character / Low LR v2 ')).toBe('krea-2-character-low-lr-v2');
    expect(isSafeJobTemplateId('krea-2-character-low-lr-v2')).toBe(true);
    expect(isSafeJobTemplateId('../outside')).toBe(false);
  });

  it('validates the complete template envelope', () => {
    expect(() =>
      validateJobTemplate({
        schema_version: JOB_TEMPLATE_SCHEMA_VERSION,
        label: 'Baseline',
        gpu_ids: '0',
        job_config: {
          job: 'extension',
          config: { name: 'job', process: [{}] },
          meta: { name: '[name]', version: '1.0' },
        },
      }),
    ).not.toThrow();

    expect(() => validateJobTemplate({ schema_version: 1, label: 'Broken' })).toThrow('gpu_ids');
  });
});
