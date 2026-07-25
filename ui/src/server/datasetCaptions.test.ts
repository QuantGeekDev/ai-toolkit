import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isSafeDatasetName,
  normalizeCaptionExtension,
  resetDatasetCaptions,
  resolveDatasetFolder,
} from './datasetCaptions';

const tempFolders: string[] = [];

const makeTempFolder = async () => {
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aitk-caption-reset-'));
  tempFolders.push(folder);
  return folder;
};

afterEach(async () => {
  await Promise.all(tempFolders.splice(0).map(folder => fs.promises.rm(folder, { recursive: true, force: true })));
});

describe('dataset caption reset', () => {
  it('normalizes safe caption extensions and rejects media or paths', () => {
    expect(normalizeCaptionExtension('.TXT')).toBe('txt');
    expect(normalizeCaptionExtension('caption')).toBe('caption');
    expect(normalizeCaptionExtension('../txt')).toBeNull();
    expect(normalizeCaptionExtension('png')).toBeNull();
    expect(normalizeCaptionExtension('')).toBeNull();
  });

  it('accepts only a single dataset path segment', () => {
    expect(isSafeDatasetName('character_set')).toBe(true);
    expect(isSafeDatasetName('../character_set')).toBe(false);
    expect(isSafeDatasetName('folder/character_set')).toBe(false);
    expect(isSafeDatasetName('..')).toBe(false);
  });

  it('resolves a real dataset only within the configured root', async () => {
    const root = await makeTempFolder();
    const dataset = path.join(root, 'character_set');
    await fs.promises.mkdir(dataset);
    await expect(resolveDatasetFolder(root, 'character_set')).resolves.toBe(await fs.promises.realpath(dataset));
    await expect(resolveDatasetFolder(root, '..')).rejects.toThrow('outside');
  });

  it('deletes only matching sidecars paired with visible media', async () => {
    const dataset = await makeTempFolder();
    const nested = path.join(dataset, 'nested');
    const controls = path.join(dataset, '_controls');
    await Promise.all([fs.promises.mkdir(nested), fs.promises.mkdir(controls)]);
    await Promise.all([
      fs.promises.writeFile(path.join(dataset, 'one.png'), ''),
      fs.promises.writeFile(path.join(dataset, 'one.txt'), 'caption one'),
      fs.promises.writeFile(path.join(dataset, 'notes.txt'), 'keep me'),
      fs.promises.writeFile(path.join(nested, 'two.jpg'), ''),
      fs.promises.writeFile(path.join(nested, 'two.txt'), 'caption two'),
      fs.promises.writeFile(path.join(nested, 'two.json'), '{"keep":true}'),
      fs.promises.writeFile(path.join(controls, 'control.png'), ''),
      fs.promises.writeFile(path.join(controls, 'control.txt'), 'keep control'),
    ]);

    await expect(resetDatasetCaptions(dataset, 'txt')).resolves.toEqual({ deleted: 2, pairedMedia: 2 });
    await expect(fs.promises.access(path.join(dataset, 'one.txt'))).rejects.toThrow();
    await expect(fs.promises.access(path.join(nested, 'two.txt'))).rejects.toThrow();
    await expect(fs.promises.readFile(path.join(dataset, 'notes.txt'), 'utf8')).resolves.toBe('keep me');
    await expect(fs.promises.readFile(path.join(nested, 'two.json'), 'utf8')).resolves.toContain('keep');
    await expect(fs.promises.readFile(path.join(controls, 'control.txt'), 'utf8')).resolves.toBe('keep control');
  });
});
