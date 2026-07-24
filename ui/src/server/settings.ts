import prisma from '@/server/prisma';
import { defaultDatasetsFolder, defaultDataRoot } from '@/paths';
import { defaultTrainFolder } from '@/paths';
import NodeCache from 'node-cache';
import fs from 'fs';

const myCache = new NodeCache();

export const flushCache = () => {
  myCache.flushAll();
};

export const getDatasetsRoot = async () => {
  const key = 'DATASETS_FOLDER';
  let datasetsPath = myCache.get(key) as string;
  if (datasetsPath) {
    return datasetsPath;
  }
  let row = await prisma.settings.findFirst({
    where: {
      key: 'DATASETS_FOLDER',
    },
  });
  datasetsPath = defaultDatasetsFolder;
  if (row?.value && row.value !== '') {
    datasetsPath = row.value;
  }
  myCache.set(key, datasetsPath);
  return datasetsPath as string;
};

export const getTrainingFolder = async () => {
  const key = 'TRAINING_FOLDER';
  let trainingRoot = myCache.get(key) as string;
  if (trainingRoot) {
    return trainingRoot;
  }
  let row = await prisma.settings.findFirst({
    where: {
      key: key,
    },
  });
  trainingRoot = defaultTrainFolder;
  if (row?.value && row.value !== '') {
    trainingRoot = row.value;
  }
  myCache.set(key, trainingRoot);
  return trainingRoot as string;
};

export const getHFToken = async () => {
  if (process.env.HF_TOKEN?.trim()) {
    return process.env.HF_TOKEN.trim();
  }
  const key = 'HF_TOKEN';
  let token = myCache.get(key) as string;
  if (token) {
    return token;
  }
  let row = await prisma.settings.findFirst({
    where: {
      key: key,
    },
  });
  token = '';
  if (row?.value && row.value !== '') {
    token = row.value;
  }
  myCache.set(key, token);
  return token;
};

export const getGeminiAPIKey = async () => {
  if (process.env.GEMINI_API_KEY?.trim()) {
    return process.env.GEMINI_API_KEY.trim();
  }
  const key = 'GEMINI_API_KEY';
  const cached = myCache.get(key) as string;
  if (cached) {
    return cached;
  }
  const row = await prisma.settings.findFirst({ where: { key } });
  const token = row?.value?.trim() || '';
  if (token) {
    myCache.set(key, token);
  }
  return token;
};

export const getSecretStatus = async (key: 'HF_TOKEN' | 'GEMINI_API_KEY') => {
  const environmentValue = process.env[key]?.trim();
  if (environmentValue) {
    return { configured: true, source: 'environment' as const };
  }
  const row = await prisma.settings.findFirst({ where: { key } });
  return {
    configured: Boolean(row?.value?.trim()),
    source: row?.value?.trim() ? ('local' as const) : null,
  };
};

export const getVertexSettings = async () => {
  const rows = await prisma.settings.findMany({
    where: {
      key: { in: ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS'] },
    },
  });
  const stored = Object.fromEntries(rows.map(row => [row.key, row.value.trim()]));
  const project = process.env.GOOGLE_CLOUD_PROJECT?.trim() || stored.GOOGLE_CLOUD_PROJECT || '';
  const location = process.env.GOOGLE_CLOUD_LOCATION?.trim() || stored.GOOGLE_CLOUD_LOCATION || 'global';
  const credentialsFile =
    process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() || stored.GOOGLE_APPLICATION_CREDENTIALS || '';
  return {
    project,
    location,
    credentialsFile,
    projectSource: process.env.GOOGLE_CLOUD_PROJECT?.trim()
      ? ('environment' as const)
      : project
        ? ('local' as const)
        : null,
    locationSource: process.env.GOOGLE_CLOUD_LOCATION?.trim()
      ? ('environment' as const)
      : stored.GOOGLE_CLOUD_LOCATION
        ? ('local' as const)
        : ('default' as const),
    credentialsSource: process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
      ? ('environment' as const)
      : credentialsFile
        ? ('local' as const)
        : null,
    credentialsFileExists: Boolean(credentialsFile && fs.existsSync(credentialsFile)),
  };
};

export const getDataRoot = async () => {
  const key = 'DATA_ROOT';
  let dataRoot = myCache.get(key) as string;
  if (dataRoot) {
    return dataRoot;
  }
  let row = await prisma.settings.findFirst({
    where: {
      key: key,
    },
  });
  dataRoot = defaultDataRoot;
  if (row?.value && row.value !== '') {
    dataRoot = row.value;
  }
  myCache.set(key, dataRoot);
  return dataRoot;
};
