import { NextResponse } from 'next/server';
import prisma from '@/server/prisma';

export async function POST(_request: Request, { params }: { params: Promise<{ jobID: string }> }) {
  const { jobID } = await params;
  if (process.env.AI_TOOLKIT_AWS_ARCHIVE_ENABLED !== '1') {
    return NextResponse.json({ error: 'AWS archive is disabled.' }, { status: 409 });
  }
  const execution = await prisma.remoteExecution.findFirst({
    where: { job_id: jobID, state: { in: ['completed', 'stopped'] }, artifact_sync_state: 'complete' },
    orderBy: { attempt: 'desc' },
  });
  if (!execution)
    return NextResponse.json({ error: 'No verified remote execution is ready to archive.' }, { status: 409 });
  await prisma.remoteExecution.update({
    where: { id: execution.id },
    data: { archive_state: 'pending', archive_error: null },
  });
  return NextResponse.json({ ok: true, executionId: execution.id, archiveState: 'pending' });
}
