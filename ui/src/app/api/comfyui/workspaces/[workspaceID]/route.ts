import { NextResponse } from 'next/server';
import prisma from '@/server/prisma';
import { comfyWorkspaceDto } from '../../../../../../cron/comfy/dto';

const find = (id: string) => prisma.comfyWorkspace.findUnique({ where: { id } });

export async function GET(_request: Request, { params }: { params: Promise<{ workspaceID: string }> }) {
  const { workspaceID } = await params;
  const workspace = await find(workspaceID);
  if (!workspace) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
  return NextResponse.json({ workspace: comfyWorkspaceDto(workspace) });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ workspaceID: string }> }) {
  const { workspaceID } = await params;
  const mode = new URL(request.url).searchParams.get('mode') || 'graceful';
  if (mode !== 'graceful' && mode !== 'immediate') {
    return NextResponse.json({ error: 'mode must be graceful or immediate.' }, { status: 400 });
  }
  const workspace = await find(workspaceID);
  if (!workspace) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
  if (['terminated', 'expired', 'failed_confirmed_absent'].includes(workspace.state)) {
    return NextResponse.json({ workspace: comfyWorkspaceDto(workspace) }, { status: 202 });
  }
  const updated = await prisma.comfyWorkspace.update({
    where: { id: workspaceID },
    data: {
      termination_mode: mode,
      termination_reason: 'user',
      termination_requested_at: workspace.termination_requested_at || new Date(),
      ...(mode === 'graceful' && workspace.preserve_outputs
        ? { output_sync_requested_at: new Date(), output_sync_state: 'requested' }
        : {}),
    },
  });
  return NextResponse.json({ workspace: comfyWorkspaceDto(updated) }, { status: 202 });
}
