import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/server/prisma';
import { exportTrainingBundle } from '../../../../../../cron/remote/bundle';
import { getRunPodConfig } from '../../../../../../cron/remote/settings';

export const runtime = 'nodejs';

export async function POST(request: NextRequest, { params }: { params: Promise<{ jobID: string }> }) {
  const { jobID } = await params;
  const job = await prisma.job.findUnique({ where: { id: jobID } });
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (job.job_type !== 'train')
    return NextResponse.json({ error: 'Only training jobs can be exported.' }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  try {
    const result = await exportTrainingBundle(job, await getRunPodConfig(), {
      validateOnly: Boolean(body.validateOnly),
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || 'Training bundle export failed.' }, { status: 422 });
  }
}
