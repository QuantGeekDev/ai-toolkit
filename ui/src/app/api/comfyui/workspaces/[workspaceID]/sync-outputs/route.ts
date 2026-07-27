import { NextResponse } from 'next/server';
import prisma from '@/server/prisma';
import { comfyWorkspaceDto } from '../../../../../../../cron/comfy/dto';

export async function POST(_request: Request, { params }: { params: Promise<{ workspaceID: string }> }) {
  const { workspaceID } = await params;
  const workspace = await prisma.comfyWorkspace.findUnique({ where: { id: workspaceID } });
  if (!workspace) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
  if (!['ready', 'busy', 'idle_grace'].includes(workspace.state)) {
    return NextResponse.json(
      { error: 'Outputs can be synchronized only while the workspace is running.' },
      { status: 409 },
    );
  }
  const updated = await prisma.comfyWorkspace.update({
    where: { id: workspaceID },
    data: { output_sync_requested_at: new Date(), output_sync_state: 'requested', output_sync_error: null },
  });
  return NextResponse.json({ workspace: comfyWorkspaceDto(updated) }, { status: 202 });
}
