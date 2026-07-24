import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import { NextResponse } from 'next/server';
import { getGeminiAPIKey, getVertexSettings } from '@/server/settings';
import { normalizeGeminiBackend, readADCQuotaProject } from '@/helpers/vertexSettings';

const errorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;
  const status = 'status' in error ? Number(error.status) : undefined;
  const code = 'code' in error ? Number(error.code) : undefined;
  return Number.isFinite(status) ? status : Number.isFinite(code) ? code : undefined;
};

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const backend = normalizeGeminiBackend(body.backend);
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'gemini-3.1-pro-preview';

    if (backend === 'developer') {
      const key = await getGeminiAPIKey();
      if (!key) {
        return NextResponse.json({ error: 'Gemini API key is not configured.' }, { status: 400 });
      }
      const client = new GoogleGenAI({ apiKey: key });
      await client.models.get({ model });
      return NextResponse.json({ success: true, backend, model });
    }

    const vertex = await getVertexSettings();
    if (!vertex.project) {
      return NextResponse.json({ error: 'Vertex AI project is not configured.' }, { status: 400 });
    }
    if (!vertex.credentialsFile) {
      return NextResponse.json({ error: 'Vertex AI ADC credentials file is not configured.' }, { status: 400 });
    }
    if (!fs.existsSync(vertex.credentialsFile)) {
      return NextResponse.json({ error: 'Vertex AI ADC credentials file does not exist.' }, { status: 400 });
    }
    const quotaProject = readADCQuotaProject(vertex.credentialsFile);
    if (quotaProject && quotaProject !== vertex.project) {
      return NextResponse.json(
        { error: `ADC quota project '${quotaProject}' does not match Vertex project '${vertex.project}'.` },
        { status: 400 },
      );
    }
    if (model === 'gemini-3.1-pro-preview' && vertex.location !== 'global') {
      return NextResponse.json(
        { error: 'gemini-3.1-pro-preview requires the global Vertex AI endpoint.' },
        { status: 400 },
      );
    }

    const client = new GoogleGenAI({
      enterprise: true,
      project: vertex.project,
      location: vertex.location,
      apiVersion: 'v1',
      googleAuthOptions: {
        keyFile: vertex.credentialsFile,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      },
    });
    await client.models.get({ model });
    return NextResponse.json({
      success: true,
      backend,
      model,
      project: vertex.project,
      location: vertex.location,
      quotaProject: quotaProject || vertex.project,
    });
  } catch (error) {
    const status = errorStatus(error);
    if (status === 401 || status === 403) {
      return NextResponse.json(
        { error: 'Google rejected the credentials or they lack access to the configured project/model.' },
        { status: 403 },
      );
    }
    if (status === 404) {
      return NextResponse.json({ error: 'The selected Gemini model was not found.' }, { status: 404 });
    }
    if (status === 429) {
      return NextResponse.json({ error: 'Google rate limit is currently exhausted.' }, { status: 429 });
    }
    const message = error instanceof Error ? error.message : '';
    if (message.includes('backend must be') || message.startsWith('ADC credentials')) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return NextResponse.json(
      { error: isTimeout ? 'Google connection test timed out.' : 'Google connection test failed.' },
      { status: 502 },
    );
  }
}
