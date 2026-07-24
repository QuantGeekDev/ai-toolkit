import { NextResponse } from 'next/server';
import { getGeminiAPIKey } from '@/server/settings';

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'gemini-3.1-pro-preview';
    const key = await getGeminiAPIKey();
    if (!key) {
      return NextResponse.json({ error: 'Gemini API key is not configured.' }, { status: 400 });
    }

    const modelName = model.startsWith('models/') ? model : `models/${model}`;
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${encodeURI(modelName)}`, {
      headers: { 'x-goog-api-key': key },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      return NextResponse.json({ success: true, model });
    }
    if (response.status === 401 || response.status === 403) {
      return NextResponse.json({ error: 'Gemini rejected the API key or it lacks model access.' }, { status: 403 });
    }
    if (response.status === 404) {
      return NextResponse.json({ error: `Gemini model '${model}' was not found.` }, { status: 404 });
    }
    if (response.status === 429) {
      return NextResponse.json({ error: 'Gemini rate limit is currently exhausted.' }, { status: 429 });
    }
    return NextResponse.json({ error: `Gemini connection test failed (${response.status}).` }, { status: 502 });
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'TimeoutError'
        ? 'Gemini connection test timed out.'
        : 'Gemini connection test failed.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
