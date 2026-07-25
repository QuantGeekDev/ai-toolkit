import { NextResponse } from 'next/server';
import { getJobTemplateStore } from '@/server/jobTemplates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const catalog = await getJobTemplateStore().list();
    return NextResponse.json(catalog, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Failed to list job templates:', error);
    return NextResponse.json({ error: 'Failed to list job templates' }, { status: 500 });
  }
}
