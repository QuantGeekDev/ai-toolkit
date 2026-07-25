import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { JOB_TEMPLATE_SCHEMA_VERSION, JobTemplate } from '../helpers/jobTemplates';
import { JobTemplateConflictError, JobTemplateStore } from './jobTemplates';

const tempFolders: string[] = [];

const makeStore = async () => {
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aitk-job-templates-'));
  tempFolders.push(folder);
  return { folder, store: new JobTemplateStore(folder) };
};

const makeTemplate = (label = 'Baseline'): JobTemplate => ({
  schema_version: JOB_TEMPLATE_SCHEMA_VERSION,
  label,
  description: 'Test training procedure',
  family: 'tests',
  gpu_ids: '0',
  job_config: {
    job: 'extension',
    config: {
      name: 'test_job',
      process: [{} as any],
    },
    meta: {
      name: '[name]',
      version: '1.0',
    },
  },
});

afterEach(async () => {
  await Promise.all(tempFolders.splice(0).map(folder => fs.promises.rm(folder, { recursive: true, force: true })));
});

describe('job template store', () => {
  it('saves, lists, loads, and defaults a complete template', async () => {
    const { folder, store } = await makeStore();
    await store.save('baseline-v1', makeTemplate());
    await store.setDefault('baseline-v1');

    await expect(store.get('baseline-v1')).resolves.toMatchObject({ label: 'Baseline', gpu_ids: '0' });
    await expect(store.list()).resolves.toMatchObject({
      default_template: 'baseline-v1',
      templates: [{ id: 'baseline-v1', label: 'Baseline', family: 'tests', gpu_ids: '0' }],
      issues: [],
    });

    const saved = await fs.promises.readFile(path.join(folder, 'baseline-v1.json'), 'utf8');
    expect(saved.endsWith('\n')).toBe(true);
    expect(JSON.parse(saved).job_config.config.name).toBe('test_job');
  });

  it('requires explicit overwrite and preserves the latest complete file', async () => {
    const { store } = await makeStore();
    await store.save('baseline-v1', makeTemplate());
    await expect(store.save('baseline-v1', makeTemplate('Changed'))).rejects.toBeInstanceOf(JobTemplateConflictError);
    await store.save('baseline-v1', makeTemplate('Changed'), true);
    await expect(store.get('baseline-v1')).resolves.toMatchObject({ label: 'Changed' });
  });

  it('rejects unsafe IDs and reports malformed JSON without hiding valid templates', async () => {
    const { folder, store } = await makeStore();
    await store.save('valid-template', makeTemplate());
    await fs.promises.writeFile(path.join(folder, 'broken.json'), '{bad json', 'utf8');

    await expect(store.get('../outside')).rejects.toThrow('Template ID');
    const catalog = await store.list();
    expect(catalog.templates.map(template => template.id)).toEqual(['valid-template']);
    expect(catalog.issues).toHaveLength(1);
    expect(catalog.issues[0]).toMatchObject({ id: 'broken' });
  });

  it('does not accept a missing template as the default', async () => {
    const { store } = await makeStore();
    await expect(store.setDefault('missing')).rejects.toThrow('was not found');
  });
});
