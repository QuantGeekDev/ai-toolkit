import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION, CaptionPromptTemplate } from '../helpers/captionPromptTemplates';
import { CaptionPromptTemplateConflictError, CaptionPromptTemplateStore } from './captionPromptTemplates';

const tempFolders: string[] = [];

const makeStore = async () => {
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aitk-caption-prompts-'));
  tempFolders.push(folder);
  return { folder, store: new CaptionPromptTemplateStore(folder) };
};

const makeTemplate = (label = 'Identity v1'): CaptionPromptTemplate => ({
  schema_version: CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION,
  label,
  description: 'Test caption procedure',
  family: 'tests',
  prompt: 'Describe the visible image and return only the caption.',
});

afterEach(async () => {
  await Promise.all(tempFolders.splice(0).map(folder => fs.promises.rm(folder, { recursive: true, force: true })));
});

describe('caption prompt template store', () => {
  it('saves, lists, loads, and defaults a complete prompt template', async () => {
    const { folder, store } = await makeStore();
    await store.save('identity-v1', makeTemplate());
    await store.setDefault('identity-v1');

    await expect(store.get('identity-v1')).resolves.toMatchObject({ label: 'Identity v1' });
    await expect(store.list()).resolves.toMatchObject({
      default_template: 'identity-v1',
      templates: [{ id: 'identity-v1', label: 'Identity v1', family: 'tests' }],
      issues: [],
    });

    const saved = await fs.promises.readFile(path.join(folder, 'identity-v1.json'), 'utf8');
    expect(saved.endsWith('\n')).toBe(true);
    expect(JSON.parse(saved).prompt).toContain('visible image');
  });

  it('requires an explicit overwrite', async () => {
    const { store } = await makeStore();
    await store.save('identity-v1', makeTemplate());
    await expect(store.save('identity-v1', makeTemplate('Changed'))).rejects.toBeInstanceOf(
      CaptionPromptTemplateConflictError,
    );
    await store.save('identity-v1', makeTemplate('Changed'), true);
    await expect(store.get('identity-v1')).resolves.toMatchObject({ label: 'Changed' });
  });

  it('rejects unsafe IDs and isolates malformed JSON files', async () => {
    const { folder, store } = await makeStore();
    await store.save('valid-prompt', makeTemplate());
    await fs.promises.writeFile(path.join(folder, 'broken.json'), '{bad json', 'utf8');

    await expect(store.get('../outside')).rejects.toThrow('Template ID');
    const catalog = await store.list();
    expect(catalog.templates.map(template => template.id)).toEqual(['valid-prompt']);
    expect(catalog.issues).toHaveLength(1);
    expect(catalog.issues[0]).toMatchObject({ id: 'broken' });
  });

  it('does not accept a missing prompt template as the default', async () => {
    const { store } = await makeStore();
    await expect(store.setDefault('missing')).rejects.toThrow('was not found');
  });
});
