import { NextRequest, NextResponse } from 'next/server';
import { JobTemplateNotFoundError, getJobTemplateStore } from '@/server/jobTemplates';
import { isSafeJobTemplateId } from '@/helpers/jobTemplates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const templateId = body.default_template;
    if (templateId !== null && !isSafeJobTemplateId(templateId)) {
      return NextResponse.json({ error: 'default_template must be a safe template ID or null' }, { status: 400 });
    }
    const index = await getJobTemplateStore().setDefault(templateId);
    return NextResponse.json(index);
  } catch (error) {
    if (error instanceof JobTemplateNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to update the default template';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
