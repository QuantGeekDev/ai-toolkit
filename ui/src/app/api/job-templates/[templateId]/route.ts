import { NextRequest, NextResponse } from 'next/server';
import { JobTemplateConflictError, JobTemplateNotFoundError, getJobTemplateStore } from '@/server/jobTemplates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ templateId: string }> };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { templateId } = await params;
  try {
    const template = await getJobTemplateStore().get(templateId);
    return NextResponse.json({ id: templateId, template }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof JobTemplateNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to load job template';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { templateId } = await params;
  try {
    const body = await request.json();
    const template = await getJobTemplateStore().save(templateId, body.template, body.overwrite === true);
    return NextResponse.json({ id: templateId, template });
  } catch (error) {
    if (error instanceof JobTemplateConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : 'Failed to save job template';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
