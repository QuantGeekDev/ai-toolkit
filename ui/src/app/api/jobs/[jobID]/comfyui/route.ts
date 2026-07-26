import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/server/prisma';
import { getComfyUISettings, getTrainingFolder } from '@/server/settings';
import {
  ComfyUiExportError,
  exportAllCheckpointsToComfyUi,
  exportCheckpointToComfyUi,
  inspectComfyUiInstallation,
  isKrea2JobConfig,
  listKrea2Checkpoints,
} from '@/server/comfyuiExport';

const getJob = async (jobID: string) => {
  const job = await prisma.job.findUnique({ where: { id: jobID } });
  if (!job) throw new ComfyUiExportError('Job not found.', 404);
  if (job.job_type !== 'train' || !isKrea2JobConfig(job.job_config)) {
    throw new ComfyUiExportError('Only Krea 2 training jobs can be sent to ComfyUI.');
  }
  return job;
};

const errorResponse = (error: unknown) => {
  if (error instanceof ComfyUiExportError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error('ComfyUI export failed:', error);
  return NextResponse.json({ error: 'Could not create the ComfyUI workflow.' }, { status: 500 });
};

export async function GET(_request: NextRequest, { params }: { params: Promise<{ jobID: string }> }) {
  try {
    const { jobID } = await params;
    const job = await getJob(jobID);
    const [trainingRoot, comfyUi] = await Promise.all([getTrainingFolder(), getComfyUISettings()]);
    const installation = await inspectComfyUiInstallation(comfyUi.root);
    const checkpoints = await listKrea2Checkpoints(trainingRoot, job.name, job.step);

    return NextResponse.json({
      ...installation,
      checkpoints,
      comfyUiUrl: comfyUi.url,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobID: string }> }) {
  try {
    const { jobID } = await params;
    const body = (await request.json()) as { mode?: unknown; checkpoint?: unknown };
    const job = await getJob(jobID);
    const [trainingRoot, comfyUi] = await Promise.all([getTrainingFolder(), getComfyUISettings()]);
    const mode = body.mode == null ? 'comparison' : body.mode;
    if (mode !== 'comparison' && mode !== 'single') {
      throw new ComfyUiExportError('Choose either the all-checkpoint comparison or a single checkpoint.');
    }
    const sharedOptions = {
      trainingRoot,
      comfyRoot: comfyUi.root,
      comfyUiUrl: comfyUi.url,
      jobName: job.name,
      currentStep: job.step,
      jobConfig: job.job_config,
    };
    const result =
      mode === 'comparison'
        ? await exportAllCheckpointsToComfyUi(sharedOptions)
        : await exportCheckpointToComfyUi({
            ...sharedOptions,
            checkpointFileName: typeof body.checkpoint === 'string' ? body.checkpoint : '',
          });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
