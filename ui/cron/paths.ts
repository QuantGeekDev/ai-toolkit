import path from 'path';
import prisma from './prisma';

export const TOOLKIT_ROOT = path.resolve('@', '..', '..');
export const defaultTrainFolder = path.join(TOOLKIT_ROOT, 'output');
export const defaultDatasetsFolder = path.join(TOOLKIT_ROOT, 'datasets');
export const defaultDataRoot = path.join(TOOLKIT_ROOT, 'data');

// Forked file-server workers set AI_TOOLKIT_QUIET_PATHS so this line prints
// once per launched process group, not once per worker.
if (!process.env.AI_TOOLKIT_QUIET_PATHS) {
  console.log('TOOLKIT_ROOT:', TOOLKIT_ROOT);
}

export const getTrainingFolder = async () => {
  const key = 'TRAINING_FOLDER';
  let row = await prisma.settings.findFirst({
    where: {
      key: key,
    },
  });
  let trainingRoot = defaultTrainFolder;
  if (row?.value && row.value !== '') {
    trainingRoot = row.value;
  }
  return trainingRoot as string;
};

export const getHFToken = async () => {
  if (process.env.HF_TOKEN?.trim()) {
    return process.env.HF_TOKEN.trim();
  }
  const key = 'HF_TOKEN';
  let row = await prisma.settings.findFirst({
    where: {
      key: key,
    },
  });
  let token = '';
  if (row?.value && row.value !== '') {
    token = row.value;
  }
  return token;
};

export const getGeminiAPIKey = async () => {
  if (process.env.GEMINI_API_KEY?.trim()) {
    return process.env.GEMINI_API_KEY.trim();
  }
  const row = await prisma.settings.findFirst({ where: { key: 'GEMINI_API_KEY' } });
  return row?.value?.trim() || '';
};

export const getVertexSettings = async () => {
  const rows = await prisma.settings.findMany({
    where: {
      key: { in: ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'] },
    },
  });
  const stored = Object.fromEntries(rows.map(row => [row.key, row.value.trim()]));
  return {
    project: process.env.GOOGLE_CLOUD_PROJECT?.trim() || stored.GOOGLE_CLOUD_PROJECT || '',
    location: process.env.GOOGLE_CLOUD_LOCATION?.trim() || stored.GOOGLE_CLOUD_LOCATION || 'global',
    credentialsFile: process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() || stored.GOOGLE_APPLICATION_CREDENTIALS || '',
  };
};
