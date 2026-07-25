import fs from 'fs';
import path from 'path';

const mediaExtensions = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.gif',
  '.tiff',
  '.mp4',
  '.avi',
  '.mov',
  '.mkv',
  '.wmv',
  '.m4v',
  '.flv',
  '.mp3',
  '.wav',
  '.flac',
  '.ogg',
]);

export const normalizeCaptionExtension = (value: unknown): string | null => {
  const extension = String(value ?? 'txt')
    .replace(/^\.+/, '')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(extension)) return null;
  if (mediaExtensions.has(`.${extension}`)) return null;
  return extension;
};

export const isSafeDatasetName = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (value === '.' || value === '..') return false;
  return !value.includes('/') && !value.includes('\\') && path.basename(value) === value;
};

const isInsideRoot = (candidate: string, root: string): boolean =>
  candidate !== root && candidate.startsWith(root + path.sep);

export const resolveDatasetFolder = async (datasetsRoot: string, datasetName: string): Promise<string> => {
  const realRoot = await fs.promises.realpath(datasetsRoot);
  const candidate = path.resolve(realRoot, datasetName);
  if (!isInsideRoot(candidate, realRoot)) {
    throw new Error('Dataset path is outside the configured datasets folder');
  }

  const realDatasetFolder = await fs.promises.realpath(candidate);
  if (!isInsideRoot(realDatasetFolder, realRoot)) {
    throw new Error('Dataset path is outside the configured datasets folder');
  }
  const stats = await fs.promises.stat(realDatasetFolder);
  if (!stats.isDirectory()) throw new Error('Dataset path is not a directory');
  return realDatasetFolder;
};

const collectCaptionPaths = async (directory: string, captionExtension: string, paths: Set<string>) => {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  const nestedDirectories: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '_controls') nestedDirectories.push(entryPath);
      continue;
    }
    if (!entry.isFile() || !mediaExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    paths.add(path.join(directory, `${path.parse(entry.name).name}.${captionExtension}`));
  }

  await Promise.all(
    nestedDirectories.map(nestedDirectory => collectCaptionPaths(nestedDirectory, captionExtension, paths)),
  );
};

export const resetDatasetCaptions = async (
  datasetFolder: string,
  captionExtension: string,
): Promise<{ deleted: number; pairedMedia: number }> => {
  const normalizedExtension = normalizeCaptionExtension(captionExtension);
  if (!normalizedExtension) throw new Error('Invalid or unsafe caption extension');

  const captionPaths = new Set<string>();
  await collectCaptionPaths(datasetFolder, normalizedExtension, captionPaths);

  let deleted = 0;
  const pendingPaths = [...captionPaths];
  const batchSize = 100;
  for (let offset = 0; offset < pendingPaths.length; offset += batchSize) {
    const batch = pendingPaths.slice(offset, offset + batchSize);
    const results = await Promise.all(
      batch.map(async captionPath => {
        try {
          await fs.promises.unlink(captionPath);
          return true;
        } catch (error: any) {
          if (error?.code === 'ENOENT') return false;
          throw error;
        }
      }),
    );
    deleted += results.filter(Boolean).length;
  }

  return { deleted, pairedMedia: captionPaths.size };
};
