'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '@/utils/api';
import {
  bundledCaptionPromptTemplateCatalog,
  CaptionPromptTemplate,
  CaptionPromptTemplateCatalog,
} from '@/helpers/captionPromptTemplates';

export default function useCaptionPromptTemplates() {
  const [catalog, setCatalog] = useState<CaptionPromptTemplateCatalog>(bundledCaptionPromptTemplateCatalog);
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const response = await apiClient.get<CaptionPromptTemplateCatalog>('/api/caption-prompt-templates', {
        headers: { 'Cache-Control': 'no-store' },
      });
      setCatalog(response.data);
      setStatus('success');
      return response.data;
    } catch (requestError: any) {
      setStatus('error');
      setError(requestError.response?.data?.error || 'Failed to load caption prompt templates.');
      throw requestError;
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const save = useCallback(
    async (id: string, template: CaptionPromptTemplate, overwrite: boolean) => {
      const response = await apiClient.put<{ id: string; template: CaptionPromptTemplate }>(
        `/api/caption-prompt-templates/${encodeURIComponent(id)}`,
        { template, overwrite },
      );
      await refresh();
      return response.data.template;
    },
    [refresh],
  );

  const setDefault = useCallback(
    async (id: string | null) => {
      await apiClient.put('/api/caption-prompt-templates/default', { default_template: id });
      await refresh();
    },
    [refresh],
  );

  return { catalog, status, error, refresh, save, setDefault };
}
