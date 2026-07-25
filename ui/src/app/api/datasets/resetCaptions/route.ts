import { NextResponse } from 'next/server';
import path from 'path';
import prisma from '@/server/prisma';
import { getDatasetsRoot } from '@/server/settings';
import {
  isSafeDatasetName,
  normalizeCaptionExtension,
  resetDatasetCaptions,
  resolveDatasetFolder,
} from '@/server/datasetCaptions';

const pathKey = (value: string) => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { datasetName } = body as { datasetName?: unknown };
    if (!isSafeDatasetName(datasetName)) {
      return NextResponse.json({ error: 'Invalid dataset name' }, { status: 400 });
    }

    const captionExtension = normalizeCaptionExtension(body.captionExtension);
    if (!captionExtension) {
      return NextResponse.json({ error: 'Invalid or unsafe caption extension' }, { status: 400 });
    }

    let datasetFolder: string;
    try {
      datasetFolder = await resolveDatasetFolder(await getDatasetsRoot(), datasetName);
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        return NextResponse.json({ error: 'Dataset not found' }, { status: 404 });
      }
      return NextResponse.json({ error: error?.message || 'Invalid dataset path' }, { status: 400 });
    }

    const activeCaptionJobs = await prisma.job.findMany({
      where: {
        job_type: 'caption',
        status: { in: ['running', 'queued', 'stopping'] },
        job_ref: { not: null },
      },
      select: { job_ref: true },
    });
    const datasetFolderKey = pathKey(datasetFolder);
    const hasActiveCaptionJob = activeCaptionJobs.some(job => job.job_ref && pathKey(job.job_ref) === datasetFolderKey);
    if (hasActiveCaptionJob) {
      return NextResponse.json({ error: 'Stop the active caption job before resetting this dataset' }, { status: 409 });
    }

    const result = await resetDatasetCaptions(datasetFolder, captionExtension);
    return NextResponse.json({ success: true, captionExtension, ...result });
  } catch (error) {
    console.error('Failed to reset dataset captions:', error);
    return NextResponse.json({ error: 'Failed to reset dataset captions' }, { status: 500 });
  }
}
