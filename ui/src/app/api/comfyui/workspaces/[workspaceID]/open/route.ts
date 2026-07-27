import { NextResponse } from 'next/server';
import prisma from '@/server/prisma';
import { signOpenAssertion } from '../../../../../../../cron/comfy/secrets';
import { getRunPodComfyConfig } from '../../../../../../../cron/comfy/settings';

export async function POST(_request: Request, { params }: { params: Promise<{ workspaceID: string }> }) {
  const { workspaceID } = await params;
  const workspace = await prisma.comfyWorkspace.findUnique({ where: { id: workspaceID } });
  if (!workspace) return NextResponse.json({ error: 'Workspace not found.' }, { status: 404 });
  if (!['ready', 'busy', 'idle_grace'].includes(workspace.state) || !workspace.public_url) {
    return NextResponse.json({ error: 'Workspace is not ready to open.' }, { status: 409 });
  }
  const config = await getRunPodComfyConfig();
  if (!config.masterSecret)
    return NextResponse.json({ error: 'Workspace authentication is unavailable.' }, { status: 503 });
  const signed = signOpenAssertion(config.masterSecret, workspace.id);
  const url = new URL(workspace.public_url);
  url.hash = `access_token=${encodeURIComponent(signed.assertion)}`;
  return NextResponse.json({ url: url.toString(), expiresAt: signed.expiresAt.toISOString() });
}
