import { NextResponse } from 'next/server';
import prisma from '@/server/prisma';

export async function GET(_request: Request, { params }: { params: Promise<{ jobID: string }> }) {
  const { jobID } = await params;
  const executions = await prisma.remoteExecution.findMany({
    where: { job_id: jobID },
    orderBy: { attempt: 'desc' },
    select: {
      id: true,
      attempt: true,
      provider: true,
      state: true,
      phase: true,
      provider_job_id: true,
      requested_gpu: true,
      actual_gpu: true,
      progress_json: true,
      submitted_at: true,
      started_at: true,
      finished_at: true,
      stop_requested_at: true,
      artifact_sync_state: true,
      archive_state: true,
      archive_prefix: true,
      archive_error: true,
      bundle_content_digest: true,
      bundle_archive_sha256: true,
      worker_image_digest: true,
      parent_execution_id: true,
      error_code: true,
      error_message: true,
      created_at: true,
      updated_at: true,
    },
  });
  return NextResponse.json({ executions });
}
