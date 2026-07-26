'use client';

import { useEffect, useState } from 'react';
import useSettings from '@/hooks/useSettings';
import { TopBar, MainContent } from '@/components/layout';
import { apiClient } from '@/utils/api';

export default function Settings() {
  const { settings, setSettings } = useSettings();
  const [status, setStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testBackend, setTestBackend] = useState<'developer' | 'vertex' | null>(null);
  const [testMessage, setTestMessage] = useState('');
  const [runPodTestStatus, setRunPodTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [runPodTestMessage, setRunPodTestMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('saving');

    apiClient
      .post('/api/settings', settings)
      .then(() => {
        setStatus('success');
        setSettings(prev => ({
          ...prev,
          HF_TOKEN: '',
          GEMINI_API_KEY: '',
          HF_TOKEN_CONFIGURED: prev.CLEAR_HF_TOKEN ? false : prev.HF_TOKEN_CONFIGURED || Boolean(prev.HF_TOKEN.trim()),
          GEMINI_API_KEY_CONFIGURED: prev.CLEAR_GEMINI_API_KEY
            ? false
            : prev.GEMINI_API_KEY_CONFIGURED || Boolean(prev.GEMINI_API_KEY.trim()),
          HF_TOKEN_SOURCE: prev.CLEAR_HF_TOKEN ? null : prev.HF_TOKEN.trim() ? 'local' : prev.HF_TOKEN_SOURCE,
          GEMINI_API_KEY_SOURCE: prev.CLEAR_GEMINI_API_KEY
            ? null
            : prev.GEMINI_API_KEY.trim()
              ? 'local'
              : prev.GEMINI_API_KEY_SOURCE,
          CLEAR_HF_TOKEN: false,
          CLEAR_GEMINI_API_KEY: false,
          GOOGLE_CLOUD_PROJECT_SOURCE:
            prev.GOOGLE_CLOUD_PROJECT_SOURCE === 'environment'
              ? 'environment'
              : prev.GOOGLE_CLOUD_PROJECT.trim()
                ? 'local'
                : null,
          GOOGLE_CLOUD_LOCATION_SOURCE:
            prev.GOOGLE_CLOUD_LOCATION_SOURCE === 'environment'
              ? 'environment'
              : prev.GOOGLE_CLOUD_LOCATION.trim()
                ? 'local'
                : 'default',
          GOOGLE_APPLICATION_CREDENTIALS_SOURCE:
            prev.GOOGLE_APPLICATION_CREDENTIALS_SOURCE === 'environment'
              ? 'environment'
              : prev.GOOGLE_APPLICATION_CREDENTIALS.trim()
                ? 'local'
                : null,
          VERTEX_ADC_CONFIGURED: Boolean(prev.GOOGLE_APPLICATION_CREDENTIALS.trim()),
          VERTEX_CONFIGURED: Boolean(prev.GOOGLE_CLOUD_PROJECT.trim() && prev.GOOGLE_APPLICATION_CREDENTIALS.trim()),
        }));
      })
      .catch(error => {
        console.error('Error saving settings:', error);
        setStatus('error');
      })
      .finally(() => {
        setTimeout(() => setStatus('idle'), 2000);
      });
  };

  const testGemini = async (backend: 'developer' | 'vertex') => {
    setTestStatus('testing');
    setTestBackend(backend);
    setTestMessage('');
    try {
      await apiClient.post('/api/settings', settings);
      const response = await apiClient.post('/api/settings/providers/gemini/test', {
        backend,
        model: 'gemini-3.1-pro-preview',
      });
      setTestStatus('success');
      setTestMessage(
        backend === 'vertex'
          ? `Connected through Vertex AI project ${response.data.project} (${response.data.location}); ADC quota project ${response.data.quotaProject}.`
          : `Connected to ${response.data.model} through the Gemini Developer API.`,
      );
      setSettings(prev => ({
        ...prev,
        GEMINI_API_KEY: '',
        GEMINI_API_KEY_CONFIGURED: backend === 'developer' ? true : prev.GEMINI_API_KEY_CONFIGURED,
        GEMINI_API_KEY_SOURCE:
          backend === 'developer'
            ? prev.GEMINI_API_KEY_SOURCE === 'environment'
              ? 'environment'
              : 'local'
            : prev.GEMINI_API_KEY_SOURCE,
        CLEAR_GEMINI_API_KEY: false,
        VERTEX_ADC_CONFIGURED: backend === 'vertex' ? true : prev.VERTEX_ADC_CONFIGURED,
        VERTEX_CONFIGURED: backend === 'vertex' ? true : prev.VERTEX_CONFIGURED,
      }));
    } catch (error: any) {
      setTestStatus('error');
      setTestMessage(error.response?.data?.error || 'Gemini connection test failed.');
    }
  };

  const secretStatus = (configured: boolean, source: 'environment' | 'local' | null) => {
    if (!configured) return 'Not configured';
    return source === 'environment' ? 'Configured by environment variable' : 'Saved locally';
  };

  const testRunPod = async () => {
    setRunPodTestStatus('testing');
    setRunPodTestMessage('');
    try {
      await apiClient.post('/api/settings', settings);
      const response = await apiClient.post('/api/settings/providers/runpod/test');
      setRunPodTestStatus('success');
      setRunPodTestMessage(
        `Endpoint passed strict H100 checks (${response.data.warnings?.length || 0} warning(s)); workersMin=0 and up to ${settings.RUNPOD_MAX_CONCURRENT_JOBS} concurrent H100 jobs.`,
      );
    } catch (error: any) {
      setRunPodTestStatus('error');
      const body = error.response?.data;
      setRunPodTestMessage(body?.errors?.join(' ') || body?.error || 'RunPod preflight failed.');
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setSettings(prev => ({
      ...prev,
      [name]: value,
      ...(name === 'HF_TOKEN' ? { CLEAR_HF_TOKEN: false } : {}),
      ...(name === 'GEMINI_API_KEY' ? { CLEAR_GEMINI_API_KEY: false } : {}),
    }));
  };

  return (
    <>
      <TopBar>
        <div>
          <h1 className="text-base sm:text-lg">Settings</h1>
        </div>
        <div className="flex-1"></div>
      </TopBar>
      <MainContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <div className="space-y-4">
                <div>
                  <label htmlFor="HF_TOKEN" className="block text-sm font-medium mb-2">
                    Hugging Face Token
                    <div className="text-gray-500 text-sm ml-1">
                      Create a Read token on{' '}
                      <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer">
                        {' '}
                        Huggingface
                      </a>{' '}
                      if you need to access gated/private models.
                    </div>
                  </label>
                  <input
                    type="password"
                    id="HF_TOKEN"
                    name="HF_TOKEN"
                    value={settings.HF_TOKEN}
                    onChange={handleChange}
                    disabled={settings.HF_TOKEN_SOURCE === 'environment'}
                    className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-transparent"
                    placeholder={
                      settings.HF_TOKEN_CONFIGURED
                        ? 'Token is configured; enter a replacement'
                        : 'Enter your Hugging Face token'
                    }
                  />
                  <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                    <span>{secretStatus(settings.HF_TOKEN_CONFIGURED, settings.HF_TOKEN_SOURCE)}</span>
                    {settings.HF_TOKEN_SOURCE === 'local' && (
                      <button
                        type="button"
                        className="text-red-400 hover:text-red-300"
                        onClick={() => setSettings(prev => ({ ...prev, HF_TOKEN: '', CLEAR_HF_TOKEN: true }))}
                      >
                        Clear saved token
                      </button>
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-gray-700 p-4">
                  <h2 className="text-sm font-medium text-gray-200">Optional AWS S3 Archive</h2>
                  <p className="mt-1 text-sm text-gray-500">
                    The local controller can archive verified bundles and artifacts after RunPod completes. Enable with
                    <code> AI_TOOLKIT_AWS_ARCHIVE_ENABLED=1</code> and launch with <code>AWS_PROFILE=echoflicks</code>{' '}
                    (or another standard AWS credential source). AWS credentials are never sent to RunPod.
                  </p>
                  <p className="mt-2 text-xs text-gray-500">
                    Status: {settings.AWS_ARCHIVE_ENABLED ? 'enabled' : 'disabled'} · AWS profile environment{' '}
                    {settings.AWS_PROFILE_CONFIGURED ? 'configured' : 'not set'}
                  </p>
                  {[
                    ['AWS_ARCHIVE_BUCKET', 'Archive bucket', 'my-private-training-archive'],
                    ['AWS_ARCHIVE_REGION', 'AWS region', 'eu-west-1'],
                    ['AWS_ARCHIVE_PREFIX', 'Key prefix', 'ai-toolkit'],
                  ].map(([name, label, placeholder]) => (
                    <div key={name} className="mt-3">
                      <label htmlFor={name} className="block text-sm font-medium">
                        {label}
                      </label>
                      <input
                        type="text"
                        id={name}
                        name={name}
                        value={String(settings[name as keyof typeof settings] || '')}
                        onChange={handleChange}
                        className="mt-1 w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg"
                        placeholder={placeholder}
                      />
                    </div>
                  ))}
                </div>

                <div>
                  <label htmlFor="GEMINI_API_KEY" className="block text-sm font-medium mb-2">
                    Gemini API Key
                    <div className="text-gray-500 text-sm ml-1">
                      Used only by the server-side cloud caption worker. Prefer a restricted authorization key or the{' '}
                      <code>GEMINI_API_KEY</code> environment variable. Saved keys are stored locally in AI Toolkit's
                      SQLite database and are not encrypted at rest.
                    </div>
                  </label>
                  <input
                    type="password"
                    id="GEMINI_API_KEY"
                    name="GEMINI_API_KEY"
                    value={settings.GEMINI_API_KEY}
                    onChange={handleChange}
                    disabled={settings.GEMINI_API_KEY_SOURCE === 'environment'}
                    className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-transparent disabled:opacity-60"
                    placeholder={
                      settings.GEMINI_API_KEY_CONFIGURED
                        ? 'Key is configured; enter a replacement'
                        : 'Enter your Gemini API key'
                    }
                  />
                  <div className="mt-2 flex items-center justify-between text-xs text-gray-500">
                    <span>{secretStatus(settings.GEMINI_API_KEY_CONFIGURED, settings.GEMINI_API_KEY_SOURCE)}</span>
                    {settings.GEMINI_API_KEY_SOURCE === 'local' && (
                      <button
                        type="button"
                        className="text-red-400 hover:text-red-300"
                        onClick={() =>
                          setSettings(prev => ({ ...prev, GEMINI_API_KEY: '', CLEAR_GEMINI_API_KEY: true }))
                        }
                      >
                        Clear saved key
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={
                      testStatus === 'testing' ||
                      (!settings.GEMINI_API_KEY_CONFIGURED && !settings.GEMINI_API_KEY.trim())
                    }
                    onClick={() => testGemini('developer')}
                    className="mt-3 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded disabled:opacity-50"
                  >
                    {testStatus === 'testing' && testBackend === 'developer' ? 'Testing...' : 'Test Developer API'}
                  </button>
                  {testMessage && testBackend === 'developer' && (
                    <p className={`mt-2 text-sm ${testStatus === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                      {testMessage}
                    </p>
                  )}
                </div>

                <div className="rounded-lg border border-gray-700 p-4">
                  <h2 className="text-sm font-medium text-gray-200">Vertex AI / Gemini Enterprise</h2>
                  <p className="mt-1 text-sm text-gray-500">
                    Uses Application Default Credentials and bills the Google Cloud project below. Gemini 3.1 Pro
                    Preview requires the <code>global</code> endpoint.
                  </p>
                  <label htmlFor="GOOGLE_CLOUD_PROJECT" className="mt-4 block text-sm font-medium">
                    Google Cloud Project ID
                  </label>
                  <input
                    type="text"
                    id="GOOGLE_CLOUD_PROJECT"
                    name="GOOGLE_CLOUD_PROJECT"
                    value={settings.GOOGLE_CLOUD_PROJECT}
                    onChange={handleChange}
                    disabled={settings.GOOGLE_CLOUD_PROJECT_SOURCE === 'environment'}
                    className="mt-2 w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-transparent disabled:opacity-60"
                    placeholder="my-google-cloud-project"
                  />
                  <label htmlFor="GOOGLE_CLOUD_LOCATION" className="mt-4 block text-sm font-medium">
                    Vertex Location
                  </label>
                  <input
                    type="text"
                    id="GOOGLE_CLOUD_LOCATION"
                    name="GOOGLE_CLOUD_LOCATION"
                    value={settings.GOOGLE_CLOUD_LOCATION}
                    onChange={handleChange}
                    disabled={settings.GOOGLE_CLOUD_LOCATION_SOURCE === 'environment'}
                    className="mt-2 w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-transparent disabled:opacity-60"
                    placeholder="global"
                  />
                  <label htmlFor="GOOGLE_APPLICATION_CREDENTIALS" className="mt-4 block text-sm font-medium">
                    ADC Credentials JSON
                  </label>
                  <input
                    type="text"
                    id="GOOGLE_APPLICATION_CREDENTIALS"
                    name="GOOGLE_APPLICATION_CREDENTIALS"
                    value={settings.GOOGLE_APPLICATION_CREDENTIALS}
                    onChange={handleChange}
                    disabled={settings.GOOGLE_APPLICATION_CREDENTIALS_SOURCE === 'environment'}
                    className="mt-2 w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-transparent disabled:opacity-60"
                    placeholder="C:\\path\\to\\application_default_credentials.json"
                  />
                  <p className="mt-2 text-xs text-gray-500">
                    The credentials file remains on disk; AI Toolkit saves only its path. Reauthenticate it with
                    <code> gcloud auth application-default login</code> if its refresh token is revoked.
                  </p>
                  <button
                    type="button"
                    disabled={
                      testStatus === 'testing' ||
                      !settings.GOOGLE_CLOUD_PROJECT.trim() ||
                      !settings.GOOGLE_APPLICATION_CREDENTIALS.trim()
                    }
                    onClick={() => testGemini('vertex')}
                    className="mt-3 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded disabled:opacity-50"
                  >
                    {testStatus === 'testing' && testBackend === 'vertex' ? 'Testing...' : 'Test Vertex AI connection'}
                  </button>
                  {testMessage && testBackend === 'vertex' && (
                    <p className={`mt-2 text-sm ${testStatus === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                      {testMessage}
                    </p>
                  )}
                </div>

                <div className="rounded-lg border border-gray-700 p-4">
                  <h2 className="text-sm font-medium text-gray-200">RunPod Serverless H100</h2>
                  <p className="mt-1 text-sm text-gray-500">
                    Optional scale-to-zero training. Secrets are accepted only through environment variables and are
                    never returned to this page. Set <code>AI_TOOLKIT_RUNPOD_ENABLED=1</code>,{' '}
                    <code>RUNPOD_API_KEY</code>,<code> RUNPOD_S3_ACCESS_ID</code>, and <code>RUNPOD_S3_SECRET</code>{' '}
                    before starting the UI.
                  </p>
                  <div className="mt-3 text-xs text-gray-500">
                    Status: {settings.RUNPOD_ENABLED ? 'enabled' : 'disabled'} · API key{' '}
                    {settings.RUNPOD_SECRETS.apiKeyConfigured ? 'configured' : 'missing'} · S3 credentials{' '}
                    {settings.RUNPOD_SECRETS.s3AccessIdConfigured && settings.RUNPOD_SECRETS.s3SecretConfigured
                      ? 'configured'
                      : 'missing'}
                  </div>
                  {[
                    ['RUNPOD_ENDPOINT_ID', 'Endpoint ID', 'RunPod Serverless endpoint ID'],
                    ['RUNPOD_NETWORK_VOLUME_ID', 'Network volume ID', 'RunPod network volume ID'],
                    ['RUNPOD_S3_ENDPOINT', 'S3 endpoint', 'https://s3api-REGION.runpod.io'],
                    ['RUNPOD_S3_REGION', 'S3 datacenter region', 'EU-RO-1'],
                    ['RUNPOD_S3_BUCKET', 'S3 bucket', 'Usually the network volume ID'],
                    ['RUNPOD_WORKER_IMAGE_DIGEST', 'Worker image digest', 'registry/image@sha256:...'],
                    ['RUNPOD_MAX_CONCURRENT_JOBS', 'Maximum concurrent H100 jobs', '1-3'],
                    ['RUNPOD_EXECUTION_TIMEOUT_MS', 'Execution timeout (ms)', '10800000'],
                    ['RUNPOD_TTL_MS', 'Queue TTL (ms)', '21600000'],
                    ['RUNPOD_BUNDLE_DIRECTORY', 'Local bundle directory', 'Blank uses output/.bundles'],
                  ].map(([name, label, placeholder]) => (
                    <div key={name} className="mt-3">
                      <label htmlFor={name} className="block text-sm font-medium">
                        {label}
                      </label>
                      <input
                        type={name === 'RUNPOD_MAX_CONCURRENT_JOBS' ? 'number' : 'text'}
                        id={name}
                        name={name}
                        min={name === 'RUNPOD_MAX_CONCURRENT_JOBS' ? 1 : undefined}
                        max={name === 'RUNPOD_MAX_CONCURRENT_JOBS' ? 3 : undefined}
                        step={name === 'RUNPOD_MAX_CONCURRENT_JOBS' ? 1 : undefined}
                        value={String(settings[name as keyof typeof settings] || '')}
                        onChange={handleChange}
                        className="mt-1 w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-transparent"
                        placeholder={placeholder}
                      />
                      {name === 'RUNPOD_MAX_CONCURRENT_JOBS' && (
                        <p className="mt-1 text-xs text-amber-500">
                          Cost safety limit: each active slot can provision one separately billed H100 worker.
                        </p>
                      )}
                    </div>
                  ))}
                  <button
                    type="button"
                    disabled={runPodTestStatus === 'testing'}
                    onClick={testRunPod}
                    className="mt-4 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded disabled:opacity-50"
                  >
                    {runPodTestStatus === 'testing' ? 'Testing...' : 'Save and test RunPod'}
                  </button>
                  {runPodTestMessage && (
                    <p className={`mt-2 text-sm ${runPodTestStatus === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                      {runPodTestMessage}
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="TRAINING_FOLDER" className="block text-sm font-medium mb-2">
                    Training Folder Path
                    <div className="text-gray-500 text-sm ml-1">
                      We will store your training information here. Must be an absolute path. If blank, it will default
                      to the output folder in the project root.
                    </div>
                  </label>
                  <input
                    type="text"
                    id="TRAINING_FOLDER"
                    name="TRAINING_FOLDER"
                    value={settings.TRAINING_FOLDER}
                    onChange={handleChange}
                    className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-transparent"
                    placeholder="Enter training folder path"
                  />
                </div>

                <div>
                  <label htmlFor="DATASETS_FOLDER" className="block text-sm font-medium mb-2">
                    Dataset Folder Path
                    <div className="text-gray-500 text-sm ml-1">
                      Where we store and find your datasets.{' '}
                      <span className="text-orange-800">
                        Warning: This software may modify datasets so it is recommended you keep a backup somewhere else
                        or have a dedicated folder for this software.
                      </span>
                    </div>
                  </label>
                  <input
                    type="text"
                    id="DATASETS_FOLDER"
                    name="DATASETS_FOLDER"
                    value={settings.DATASETS_FOLDER}
                    onChange={handleChange}
                    className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-transparent"
                    placeholder="Enter datasets folder path"
                  />
                </div>
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={status === 'saving'}
            className="w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {status === 'saving' ? 'Saving...' : 'Save Settings'}
          </button>

          {status === 'success' && <p className="text-green-500 text-center">Settings saved successfully!</p>}
          {status === 'error' && <p className="text-red-500 text-center">Error saving settings. Please try again.</p>}
        </form>
      </MainContent>
    </>
  );
}
