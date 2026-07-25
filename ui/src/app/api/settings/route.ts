import { NextResponse } from 'next/server';
import prisma from '@/server/prisma';
import { defaultTrainFolder, defaultDatasetsFolder } from '@/paths';
import { flushCache, getSecretStatus, getVertexSettings } from '@/server/settings';
import { buildPublicSettings, getSecretMutation } from '@/helpers/settingsSecrets';
import { normalizeVertexSettings } from '@/helpers/vertexSettings';
import { AWS_ARCHIVE_SETTING_KEYS, RUNPOD_SETTING_KEYS, runPodSecretStatus } from '../../../../cron/remote/settings';

export async function GET() {
  try {
    const settings = await prisma.settings.findMany({
      where: {
        key: { in: ['TRAINING_FOLDER', 'DATASETS_FOLDER', ...RUNPOD_SETTING_KEYS, ...AWS_ARCHIVE_SETTING_KEYS] },
      },
    });
    const [hfToken, geminiApiKey, vertex] = await Promise.all([
      getSecretStatus('HF_TOKEN'),
      getSecretStatus('GEMINI_API_KEY'),
      getVertexSettings(),
    ]);
    const publicSettings = buildPublicSettings(
      settings,
      { trainingFolder: defaultTrainFolder, datasetsFolder: defaultDatasetsFolder },
      { hfToken, geminiApiKey },
      vertex,
    );
    const stored = Object.fromEntries(settings.map(row => [row.key, row.value]));
    const remote = Object.fromEntries(
      RUNPOD_SETTING_KEYS.map(key => [key, process.env[key]?.trim() || stored[key] || '']),
    );
    return NextResponse.json({
      ...publicSettings,
      ...remote,
      RUNPOD_ENABLED: process.env.AI_TOOLKIT_RUNPOD_ENABLED === '1',
      RUNPOD_SECRETS: runPodSecretStatus(),
      ...Object.fromEntries(AWS_ARCHIVE_SETTING_KEYS.map(key => [key, process.env[key]?.trim() || stored[key] || ''])),
      AWS_ARCHIVE_ENABLED: process.env.AI_TOOLKIT_AWS_ARCHIVE_ENABLED === '1',
      AWS_PROFILE_CONFIGURED: Boolean(process.env.AWS_PROFILE?.trim()),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { HF_TOKEN, GEMINI_API_KEY, TRAINING_FOLDER, DATASETS_FOLDER, CLEAR_HF_TOKEN, CLEAR_GEMINI_API_KEY } = body;
    const vertexSettings = normalizeVertexSettings(body);

    const operations: Promise<unknown>[] = [];
    if (typeof TRAINING_FOLDER === 'string') {
      operations.push(
        prisma.settings.upsert({
          where: { key: 'TRAINING_FOLDER' },
          update: { value: TRAINING_FOLDER },
          create: { key: 'TRAINING_FOLDER', value: TRAINING_FOLDER },
        }),
      );
    }
    if (typeof DATASETS_FOLDER === 'string') {
      operations.push(
        prisma.settings.upsert({
          where: { key: 'DATASETS_FOLDER' },
          update: { value: DATASETS_FOLDER },
          create: { key: 'DATASETS_FOLDER', value: DATASETS_FOLDER },
        }),
      );
    }

    const updatePlainSetting = (key: keyof typeof vertexSettings, value: string | undefined) => {
      if (value === undefined) return;
      if (!value) {
        operations.push(prisma.settings.deleteMany({ where: { key } }));
        return;
      }
      operations.push(
        prisma.settings.upsert({
          where: { key },
          update: { value },
          create: { key, value },
        }),
      );
    };
    updatePlainSetting('GOOGLE_CLOUD_PROJECT', vertexSettings.GOOGLE_CLOUD_PROJECT);
    updatePlainSetting('GOOGLE_CLOUD_LOCATION', vertexSettings.GOOGLE_CLOUD_LOCATION);
    updatePlainSetting('GOOGLE_APPLICATION_CREDENTIALS', vertexSettings.GOOGLE_APPLICATION_CREDENTIALS);

    for (const key of RUNPOD_SETTING_KEYS) {
      const value = body[key];
      if (typeof value !== 'string' || process.env[key]?.trim()) continue;
      if (!value.trim()) operations.push(prisma.settings.deleteMany({ where: { key } }));
      else {
        operations.push(
          prisma.settings.upsert({
            where: { key },
            update: { value: value.trim() },
            create: { key, value: value.trim() },
          }),
        );
      }
    }
    for (const key of AWS_ARCHIVE_SETTING_KEYS) {
      const value = body[key];
      if (typeof value !== 'string' || process.env[key]?.trim()) continue;
      if (!value.trim()) operations.push(prisma.settings.deleteMany({ where: { key } }));
      else {
        operations.push(
          prisma.settings.upsert({
            where: { key },
            update: { value: value.trim() },
            create: { key, value: value.trim() },
          }),
        );
      }
    }

    const updateSecret = (key: 'HF_TOKEN' | 'GEMINI_API_KEY', value: unknown, clear: unknown) => {
      const mutation = getSecretMutation(value, clear);
      if (mutation.action === 'clear') {
        operations.push(prisma.settings.deleteMany({ where: { key } }));
      } else if (mutation.action === 'set') {
        operations.push(
          prisma.settings.upsert({
            where: { key },
            update: { value: mutation.value },
            create: { key, value: mutation.value },
          }),
        );
      }
    };
    updateSecret('HF_TOKEN', HF_TOKEN, CLEAR_HF_TOKEN);
    updateSecret('GEMINI_API_KEY', GEMINI_API_KEY, CLEAR_GEMINI_API_KEY);
    await Promise.all(operations);

    flushCache();

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update settings';
    const isValidationError = message.startsWith('Vertex AI') || message.startsWith('ADC credentials');
    return NextResponse.json(
      { error: isValidationError ? message : 'Failed to update settings' },
      { status: isValidationError ? 400 : 500 },
    );
  }
}
