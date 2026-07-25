import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/server/prisma';

export async function GET(request: NextRequest, { params }: { params: { jobID: string } }) {
  const { jobID } = await params;

  const existing = await prisma.job.findUnique({ where: { id: jobID } });
  if (!existing) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (existing.execution_target === 'runpod_serverless') {
    return NextResponse.json(
      { error: 'On-demand saves are not supported remotely; use save_every in the bundle.' },
      { status: 409 },
    );
  }

  const job = await prisma.job.update({
    where: { id: jobID },
    data: {
      save_now: true,
    },
  });

  console.log(`Job ${jobID} marked to save on next step`);

  return NextResponse.json(job);
}
