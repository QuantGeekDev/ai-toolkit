import { NextRequest, NextResponse } from 'next/server';
import {
  CaptionPromptTemplateConflictError,
  CaptionPromptTemplateNotFoundError,
  getCaptionPromptTemplateStore,
} from '@/server/captionPromptTemplates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ templateId: string }> };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { templateId } = await params;
  try {
    const template = await getCaptionPromptTemplateStore().get(templateId);
    return NextResponse.json({ id: templateId, template }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof CaptionPromptTemplateNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to load caption prompt template';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { templateId } = await params;
  try {
    const body = await request.json();
    const template = await getCaptionPromptTemplateStore().save(templateId, body.template, body.overwrite === true);
    return NextResponse.json({ id: templateId, template });
  } catch (error) {
    if (error instanceof CaptionPromptTemplateConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : 'Failed to save caption prompt template';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
