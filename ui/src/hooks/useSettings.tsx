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
  RUNPOD_ENABLED: boolean;
  RUNPOD_ENDPOINT_ID: string;
  RUNPOD_NETWORK_VOLUME_ID: string;
  RUNPOD_S3_ENDPOINT: string;
  RUNPOD_S3_REGION: string;
  RUNPOD_S3_BUCKET: string;
  RUNPOD_WORKER_IMAGE_DIGEST: string;
  RUNPOD_MAX_CONCURRENT_JOBS: string;
  RUNPOD_EXECUTION_TIMEOUT_MS: string;
  RUNPOD_TTL_MS: string;
  RUNPOD_BUNDLE_DIRECTORY: string;
  RUNPOD_SECRETS: {
    apiKeyConfigured: boolean;
    s3AccessIdConfigured: boolean;
    s3SecretConfigured: boolean;
    hfTokenConfigured: boolean;
    source: string;
  };
  AWS_ARCHIVE_ENABLED: boolean;
  AWS_ARCHIVE_BUCKET: string;
  AWS_ARCHIVE_REGION: string;
  AWS_ARCHIVE_PREFIX: string;
  AWS_PROFILE_CONFIGURED: boolean;
  RUNPOD_COMFY_ENABLED: boolean;
  RUNPOD_COMFY_IMAGE_DIGEST: string;
  RUNPOD_COMFY_GPU_IDS: string;
  RUNPOD_COMFY_MAX_HOURLY_RATE: string;
  RUNPOD_COMFY_DEFAULT_MAX_HOURS: string;
  RUNPOD_COMFY_ALLOWED_MAX_HOURS: string;
  RUNPOD_COMFY_IDLE_MINUTES: string;
  RUNPOD_COMFY_MIN_CONTAINER_DISK_GB: string;
  RUNPOD_COMFY_MAX_CONTAINER_DISK_GB: string;
  RUNPOD_COMFY_OUTPUT_ALLOWANCE_GB: string;
  RUNPOD_COMFY_CAPACITY_WAIT_MINUTES: string;
  RUNPOD_COMFY_MAX_ACTIVE: string;
  RUNPOD_COMFY_HF_SECRET_NAME: string;
  RUNPOD_COMFY_REGISTRY_AUTH_ID: string;
  RUNPOD_COMFY_SSH_PUBLIC_KEY: string;
  RUNPOD_COMFY_LOCAL_STAGING_DIRECTORY: string;
  RUNPOD_COMFY_CAPABILITY_REPORT: string;
  RUNPOD_COMFY_MODEL_MANIFEST_SHA256: string;
  RUNPOD_COMFY_SECRETS: {
    apiKeyConfigured: boolean;
    deploymentAuthConfigured: boolean;
    masterSecretConfigured: boolean;
    privateKeyConfigured: boolean;
    source: string;
  };
  RUNPOD_COMFY_CONFIGURATION_ERRORS: string[];
  RUNPOD_COMFY_ACTIVE_WORKSPACE: null | {
    id: string;
    state: string;
    hourlyRate: number | null;
    expiresAt: string | null;
  };
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
    RUNPOD_ENABLED: false,
    RUNPOD_ENDPOINT_ID: '',
    RUNPOD_NETWORK_VOLUME_ID: '',
    RUNPOD_S3_ENDPOINT: '',
    RUNPOD_S3_REGION: '',
    RUNPOD_S3_BUCKET: '',
    RUNPOD_WORKER_IMAGE_DIGEST: '',
    RUNPOD_MAX_CONCURRENT_JOBS: '1',
    RUNPOD_EXECUTION_TIMEOUT_MS: '10800000',
    RUNPOD_TTL_MS: '21600000',
    RUNPOD_BUNDLE_DIRECTORY: '',
    RUNPOD_SECRETS: {
      apiKeyConfigured: false,
      s3AccessIdConfigured: false,
      s3SecretConfigured: false,
      hfTokenConfigured: false,
      source: 'environment',
    },
    AWS_ARCHIVE_ENABLED: false,
    AWS_ARCHIVE_BUCKET: '',
    AWS_ARCHIVE_REGION: 'us-east-1',
    AWS_ARCHIVE_PREFIX: 'ai-toolkit',
    AWS_PROFILE_CONFIGURED: false,
    RUNPOD_COMFY_ENABLED: false,
    RUNPOD_COMFY_IMAGE_DIGEST: '',
    RUNPOD_COMFY_GPU_IDS: 'NVIDIA H100 80GB HBM3,NVIDIA H100 PCIe',
    RUNPOD_COMFY_MAX_HOURLY_RATE: '3.50',
    RUNPOD_COMFY_DEFAULT_MAX_HOURS: '2',
    RUNPOD_COMFY_ALLOWED_MAX_HOURS: '1,2,4,8',
    RUNPOD_COMFY_IDLE_MINUTES: '60',
    RUNPOD_COMFY_MIN_CONTAINER_DISK_GB: '100',
    RUNPOD_COMFY_MAX_CONTAINER_DISK_GB: '200',
    RUNPOD_COMFY_OUTPUT_ALLOWANCE_GB: '20',
    RUNPOD_COMFY_CAPACITY_WAIT_MINUTES: '15',
    RUNPOD_COMFY_MAX_ACTIVE: '1',
    RUNPOD_COMFY_HF_SECRET_NAME: 'aitk_hf_read',
    RUNPOD_COMFY_REGISTRY_AUTH_ID: '',
    RUNPOD_COMFY_SSH_PUBLIC_KEY: '',
    RUNPOD_COMFY_LOCAL_STAGING_DIRECTORY: '',
    RUNPOD_COMFY_CAPABILITY_REPORT: '',
    RUNPOD_COMFY_MODEL_MANIFEST_SHA256: '',
    RUNPOD_COMFY_SECRETS: {
      apiKeyConfigured: false,
      deploymentAuthConfigured: false,
      masterSecretConfigured: false,
      privateKeyConfigured: false,
      source: 'environment',
    },
    RUNPOD_COMFY_CONFIGURATION_ERRORS: [],
    RUNPOD_COMFY_ACTIVE_WORKSPACE: null,
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
          RUNPOD_ENABLED: Boolean(data.RUNPOD_ENABLED),
          RUNPOD_ENDPOINT_ID: data.RUNPOD_ENDPOINT_ID || '',
          RUNPOD_NETWORK_VOLUME_ID: data.RUNPOD_NETWORK_VOLUME_ID || '',
          RUNPOD_S3_ENDPOINT: data.RUNPOD_S3_ENDPOINT || '',
          RUNPOD_S3_REGION: data.RUNPOD_S3_REGION || '',
          RUNPOD_S3_BUCKET: data.RUNPOD_S3_BUCKET || '',
          RUNPOD_WORKER_IMAGE_DIGEST: data.RUNPOD_WORKER_IMAGE_DIGEST || '',
          RUNPOD_MAX_CONCURRENT_JOBS: data.RUNPOD_MAX_CONCURRENT_JOBS || '1',
          RUNPOD_EXECUTION_TIMEOUT_MS: data.RUNPOD_EXECUTION_TIMEOUT_MS || '10800000',
          RUNPOD_TTL_MS: data.RUNPOD_TTL_MS || '21600000',
          RUNPOD_BUNDLE_DIRECTORY: data.RUNPOD_BUNDLE_DIRECTORY || '',
          RUNPOD_SECRETS: data.RUNPOD_SECRETS || {
            apiKeyConfigured: false,
            s3AccessIdConfigured: false,
            s3SecretConfigured: false,
            hfTokenConfigured: false,
            source: 'environment',
          },
          AWS_ARCHIVE_ENABLED: Boolean(data.AWS_ARCHIVE_ENABLED),
          AWS_ARCHIVE_BUCKET: data.AWS_ARCHIVE_BUCKET || '',
          AWS_ARCHIVE_REGION: data.AWS_ARCHIVE_REGION || 'us-east-1',
          AWS_ARCHIVE_PREFIX: data.AWS_ARCHIVE_PREFIX || 'ai-toolkit',
          AWS_PROFILE_CONFIGURED: Boolean(data.AWS_PROFILE_CONFIGURED),
          RUNPOD_COMFY_ENABLED: Boolean(data.RUNPOD_COMFY_ENABLED),
          RUNPOD_COMFY_IMAGE_DIGEST: data.RUNPOD_COMFY_IMAGE_DIGEST || '',
          RUNPOD_COMFY_GPU_IDS: data.RUNPOD_COMFY_GPU_IDS || 'NVIDIA H100 80GB HBM3,NVIDIA H100 PCIe',
          RUNPOD_COMFY_MAX_HOURLY_RATE: data.RUNPOD_COMFY_MAX_HOURLY_RATE || '3.50',
          RUNPOD_COMFY_DEFAULT_MAX_HOURS: data.RUNPOD_COMFY_DEFAULT_MAX_HOURS || '2',
          RUNPOD_COMFY_ALLOWED_MAX_HOURS: data.RUNPOD_COMFY_ALLOWED_MAX_HOURS || '1,2,4,8',
          RUNPOD_COMFY_IDLE_MINUTES: data.RUNPOD_COMFY_IDLE_MINUTES || '60',
          RUNPOD_COMFY_MIN_CONTAINER_DISK_GB: data.RUNPOD_COMFY_MIN_CONTAINER_DISK_GB || '100',
          RUNPOD_COMFY_MAX_CONTAINER_DISK_GB: data.RUNPOD_COMFY_MAX_CONTAINER_DISK_GB || '200',
          RUNPOD_COMFY_OUTPUT_ALLOWANCE_GB: data.RUNPOD_COMFY_OUTPUT_ALLOWANCE_GB || '20',
          RUNPOD_COMFY_CAPACITY_WAIT_MINUTES: data.RUNPOD_COMFY_CAPACITY_WAIT_MINUTES || '15',
          RUNPOD_COMFY_MAX_ACTIVE: data.RUNPOD_COMFY_MAX_ACTIVE || '1',
          RUNPOD_COMFY_HF_SECRET_NAME: data.RUNPOD_COMFY_HF_SECRET_NAME || 'aitk_hf_read',
          RUNPOD_COMFY_REGISTRY_AUTH_ID: data.RUNPOD_COMFY_REGISTRY_AUTH_ID || '',
          RUNPOD_COMFY_SSH_PUBLIC_KEY: data.RUNPOD_COMFY_SSH_PUBLIC_KEY || '',
          RUNPOD_COMFY_LOCAL_STAGING_DIRECTORY: data.RUNPOD_COMFY_LOCAL_STAGING_DIRECTORY || '',
          RUNPOD_COMFY_CAPABILITY_REPORT: data.RUNPOD_COMFY_CAPABILITY_REPORT || '',
          RUNPOD_COMFY_MODEL_MANIFEST_SHA256: data.RUNPOD_COMFY_MODEL_MANIFEST_SHA256 || '',
          RUNPOD_COMFY_SECRETS: data.RUNPOD_COMFY_SECRETS || {
            apiKeyConfigured: false,
            deploymentAuthConfigured: false,
            masterSecretConfigured: false,
            privateKeyConfigured: false,
            source: 'environment',
          },
          RUNPOD_COMFY_CONFIGURATION_ERRORS: data.RUNPOD_COMFY_CONFIGURATION_ERRORS || [],
          RUNPOD_COMFY_ACTIVE_WORKSPACE: data.RUNPOD_COMFY_ACTIVE_WORKSPACE || null,
        });
        setIsLoaded(true);
      })
      .catch(error => console.error('Error fetching settings:', error));
  }, []);

  return { settings, setSettings, isSettingsLoaded };
}
