import { NextResponse } from 'next/server';
import { getCaptionPromptTemplateStore } from '@/server/captionPromptTemplates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const catalog = await getCaptionPromptTemplateStore().list();
    return NextResponse.json(catalog, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Failed to list caption prompt templates:', error);
    return NextResponse.json({ error: 'Failed to list caption prompt templates' }, { status: 500 });
  }
}
