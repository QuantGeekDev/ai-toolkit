'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '@/utils/api';
import type { JobTemplate, JobTemplateCatalog } from '@/helpers/jobTemplates';

const emptyCatalog: JobTemplateCatalog = {
  schema_version: 1,
  default_template: null,
  templates: [],
  issues: [],
};

export default function useJobTemplates() {
  const [catalog, setCatalog] = useState<JobTemplateCatalog>(emptyCatalog);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      const response = await apiClient.get<JobTemplateCatalog>('/api/job-templates', {
        headers: { 'Cache-Control': 'no-store' },
      });
      setCatalog(response.data);
      setStatus('success');
      return response.data;
    } catch (requestError: any) {
      setStatus('error');
      const message = requestError.response?.data?.error || 'Failed to load job templates.';
      setError(message);
      throw requestError;
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const load = useCallback(async (id: string): Promise<JobTemplate> => {
    const response = await apiClient.get<{ id: string; template: JobTemplate }>(
      `/api/job-templates/${encodeURIComponent(id)}`,
      { headers: { 'Cache-Control': 'no-store' } },
    );
    return response.data.template;
  }, []);

  const save = useCallback(
    async (id: string, template: JobTemplate, overwrite: boolean): Promise<JobTemplate> => {
      const response = await apiClient.put<{ id: string; template: JobTemplate }>(
        `/api/job-templates/${encodeURIComponent(id)}`,
        { template, overwrite },
      );
      await refresh();
      return response.data.template;
    },
    [refresh],
  );

  const setDefault = useCallback(
    async (id: string | null) => {
      await apiClient.put('/api/job-templates/default', { default_template: id });
      await refresh();
    },
    [refresh],
  );

  return { catalog, status, error, refresh, load, save, setDefault };
}
