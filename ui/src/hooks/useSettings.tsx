'use client';

import { useEffect, useState } from 'react';
import { apiClient } from '@/utils/api';

export interface Settings {
  HF_TOKEN: string;
  GEMINI_API_KEY: string;
  TRAINING_FOLDER: string;
  DATASETS_FOLDER: string;
  HF_TOKEN_CONFIGURED: boolean;
  HF_TOKEN_SOURCE: 'environment' | 'local' | null;
  GEMINI_API_KEY_CONFIGURED: boolean;
  GEMINI_API_KEY_SOURCE: 'environment' | 'local' | null;
  CLEAR_HF_TOKEN: boolean;
  CLEAR_GEMINI_API_KEY: boolean;
  GOOGLE_CLOUD_PROJECT: string;
  GOOGLE_CLOUD_LOCATION: string;
  GOOGLE_APPLICATION_CREDENTIALS: string;
  GOOGLE_CLOUD_PROJECT_SOURCE: 'environment' | 'local' | null;
  GOOGLE_CLOUD_LOCATION_SOURCE: 'environment' | 'local' | 'default';
  GOOGLE_APPLICATION_CREDENTIALS_SOURCE: 'environment' | 'local' | null;
  VERTEX_ADC_CONFIGURED: boolean;
  VERTEX_CONFIGURED: boolean;
}

export default function useSettings() {
  const [settings, setSettings] = useState<Settings>({
    HF_TOKEN: '',
    GEMINI_API_KEY: '',
    TRAINING_FOLDER: '',
    DATASETS_FOLDER: '',
    HF_TOKEN_CONFIGURED: false,
    HF_TOKEN_SOURCE: null,
    GEMINI_API_KEY_CONFIGURED: false,
    GEMINI_API_KEY_SOURCE: null,
    CLEAR_HF_TOKEN: false,
    CLEAR_GEMINI_API_KEY: false,
    GOOGLE_CLOUD_PROJECT: '',
    GOOGLE_CLOUD_LOCATION: 'global',
    GOOGLE_APPLICATION_CREDENTIALS: '',
    GOOGLE_CLOUD_PROJECT_SOURCE: null,
    GOOGLE_CLOUD_LOCATION_SOURCE: 'default',
    GOOGLE_APPLICATION_CREDENTIALS_SOURCE: null,
    VERTEX_ADC_CONFIGURED: false,
    VERTEX_CONFIGURED: false,
  });
  const [isSettingsLoaded, setIsLoaded] = useState(false);
  useEffect(() => {
    apiClient
      .get('/api/settings')
      .then(res => res.data)
      .then(data => {
        setSettings({
          HF_TOKEN: '',
          GEMINI_API_KEY: '',
          TRAINING_FOLDER: data.TRAINING_FOLDER || '',
          DATASETS_FOLDER: data.DATASETS_FOLDER || '',
          HF_TOKEN_CONFIGURED: Boolean(data.HF_TOKEN_CONFIGURED),
          HF_TOKEN_SOURCE: data.HF_TOKEN_SOURCE || null,
          GEMINI_API_KEY_CONFIGURED: Boolean(data.GEMINI_API_KEY_CONFIGURED),
          GEMINI_API_KEY_SOURCE: data.GEMINI_API_KEY_SOURCE || null,
          CLEAR_HF_TOKEN: false,
          CLEAR_GEMINI_API_KEY: false,
          GOOGLE_CLOUD_PROJECT: data.GOOGLE_CLOUD_PROJECT || '',
          GOOGLE_CLOUD_LOCATION: data.GOOGLE_CLOUD_LOCATION || 'global',
          GOOGLE_APPLICATION_CREDENTIALS: data.GOOGLE_APPLICATION_CREDENTIALS || '',
          GOOGLE_CLOUD_PROJECT_SOURCE: data.GOOGLE_CLOUD_PROJECT_SOURCE || null,
          GOOGLE_CLOUD_LOCATION_SOURCE: data.GOOGLE_CLOUD_LOCATION_SOURCE || 'default',
          GOOGLE_APPLICATION_CREDENTIALS_SOURCE: data.GOOGLE_APPLICATION_CREDENTIALS_SOURCE || null,
          VERTEX_ADC_CONFIGURED: Boolean(data.VERTEX_ADC_CONFIGURED),
          VERTEX_CONFIGURED: Boolean(data.VERTEX_CONFIGURED),
        });
        setIsLoaded(true);
      })
      .catch(error => console.error('Error fetching settings:', error));
  }, []);

  return { settings, setSettings, isSettingsLoaded };
}
