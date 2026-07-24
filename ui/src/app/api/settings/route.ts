import { NextResponse } from 'next/server';
import prisma from '@/server/prisma';
import { defaultTrainFolder, defaultDatasetsFolder } from '@/paths';
import { flushCache, getSecretStatus } from '@/server/settings';
import { buildPublicSettings, getSecretMutation } from '@/helpers/settingsSecrets';

export async function GET() {
  try {
    const settings = await prisma.settings.findMany({
      where: { key: { in: ['TRAINING_FOLDER', 'DATASETS_FOLDER'] } },
    });
    const [hfToken, geminiApiKey] = await Promise.all([getSecretStatus('HF_TOKEN'), getSecretStatus('GEMINI_API_KEY')]);
    return NextResponse.json(
      buildPublicSettings(
        settings,
        { trainingFolder: defaultTrainFolder, datasetsFolder: defaultDatasetsFolder },
        { hfToken, geminiApiKey },
      ),
    );
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { HF_TOKEN, GEMINI_API_KEY, TRAINING_FOLDER, DATASETS_FOLDER, CLEAR_HF_TOKEN, CLEAR_GEMINI_API_KEY } = body;

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
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}
