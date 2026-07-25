'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { defaultJobConfig, prepareJobConfig } from './jobConfig';
import { jobTypeOptions } from './options';
import { JobConfig } from '@/types';
import { objectCopy } from '@/utils/basic';
import { useNestedState } from '@/utils/hooks';
import { SelectInput } from '@/components/formInputs';
import useSettings from '@/hooks/useSettings';
import useGPUInfo from '@/hooks/useGPUInfo';
import useDatasetList from '@/hooks/useDatasetList';
import useJobTemplates from '@/hooks/useJobTemplates';
import YAML from 'yaml';
import path from 'path';
import { TopBar, MainContent } from '@/components/layout';
import { Button } from '@headlessui/react';
import { FaChevronLeft } from 'react-icons/fa';
import SimpleJob from './SimpleJob';
import AdvancedConfigEditor from '@/components/AdvancedConfigEditor';
import ErrorBoundary from '@/components/ErrorBoundary';
import { apiClient } from '@/utils/api';
import JobTemplateControls from './JobTemplateControls';
import { JobTemplate, snapshotJobTemplateState } from '@/helpers/jobTemplates';

export default function TrainingForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const runId = searchParams.get('id');
  const cloneId = searchParams.get('cloneId');
  const requestedTemplateId = searchParams.get('template');
  const [gpuIDs, setGpuIDs] = useState<string | null>(null);
  const [executionTarget, setExecutionTarget] = useState<'local' | 'runpod_serverless'>('local');
  const { settings, isSettingsLoaded } = useSettings();
  const { gpuList, isGPUInfoLoaded } = useGPUInfo();
  const { datasets, status: datasetFetchStatus } = useDatasetList();

  useEffect(() => {
    if (
      executionTarget === 'local' &&
      (gpuIDs === 'runpod:h100' || gpuIDs === 'cloud' || gpuIDs == null) &&
      gpuList.length > 0
    ) {
      setGpuIDs(`${gpuList[0].index}`);
    }
  }, [executionTarget, gpuIDs, gpuList]);
  const {
    catalog: templateCatalog,
    status: templateCatalogStatus,
    error: templateCatalogError,
    load: loadTemplate,
    save: saveTemplate,
    setDefault: setDefaultTemplate,
  } = useJobTemplates();
  const [datasetOptions, setDatasetOptions] = useState<{ value: string; label: string }[]>([]);
  const [showAdvancedView, setShowAdvancedView] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [initializationStatus, setInitializationStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [initializationError, setInitializationError] = useState<string | null>(null);

  const [jobConfig, setJobConfig] = useNestedState<JobConfig>(objectCopy(defaultJobConfig));
  const [status, setStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const initializationStartedRef = useRef(false);
  const baselineSnapshotRef = useRef('');

  const prepareConfig = useCallback(
    (source: unknown) =>
      prepareJobConfig(source, {
        trainingFolder: settings.TRAINING_FOLDER,
        firstDatasetPath: datasets[0] ? path.join(settings.DATASETS_FOLDER, datasets[0]) : undefined,
      }),
    [datasets, settings.DATASETS_FOLDER, settings.TRAINING_FOLDER],
  );

  const handleImportConfig = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = reader.result as string;
        let parsed: any;
        if (file.name.endsWith('.json') || file.name.endsWith('.jsonc')) {
          parsed = JSON.parse(text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
        } else {
          parsed = YAML.parse(text);
        }

        const prepared = prepareConfig(parsed);
        setJobConfig(prepared);
        setSelectedTemplateId(null);
      } catch (err) {
        console.error('Failed to parse config file:', err);
        alert('Failed to parse config file. Please check the file format.');
      }
    };
    reader.readAsText(file);

    // Reset so the same file can be re-imported
    e.target.value = '';
  };

  useEffect(() => {
    if (!isSettingsLoaded) return;
    if (datasetFetchStatus !== 'success') return;

    const datasetOptions = datasets.map(name => ({ value: path.join(settings.DATASETS_FOLDER, name), label: name }));
    setDatasetOptions(datasetOptions);
  }, [datasets, settings, isSettingsLoaded, datasetFetchStatus]);

  useEffect(() => {
    if (initializationStartedRef.current) return;
    if (!isSettingsLoaded || !isGPUInfoLoaded || datasetFetchStatus !== 'success') return;
    if (!runId && !cloneId && ['idle', 'loading'].includes(templateCatalogStatus)) return;

    initializationStartedRef.current = true;
    setInitializationStatus('loading');
    setInitializationError(null);

    const initialize = async () => {
      try {
        let sourceConfig: unknown = defaultJobConfig;
        let sourceGpuIDs: string | null = gpuList.length > 0 ? `${gpuList[0].index}` : null;
        let sourceTemplateId: string | null = null;
        let sourceExecutionTarget: 'local' | 'runpod_serverless' = 'local';

        if (runId || cloneId) {
          const sourceId = runId || cloneId;
          const response = await apiClient.get(`/api/jobs?id=${sourceId}`);
          if (!response.data?.job_config) throw new Error('The requested training job was not found.');
          sourceConfig = JSON.parse(response.data.job_config);
          sourceGpuIDs = response.data.gpu_ids;
          sourceExecutionTarget =
            response.data.execution_target === 'runpod_serverless' ? 'runpod_serverless' : 'local';
          if (!runId && cloneId) {
            const clonedConfig = objectCopy(sourceConfig as JobConfig);
            clonedConfig.config.name = `${clonedConfig.config.name}_copy`;
            sourceConfig = clonedConfig;
          }
        } else {
          const preferredTemplateId = requestedTemplateId || templateCatalog.default_template;
          if (preferredTemplateId) {
            const template = await loadTemplate(preferredTemplateId);
            sourceConfig = template.job_config;
            sourceGpuIDs = template.gpu_ids ?? sourceGpuIDs;
            sourceTemplateId = preferredTemplateId;
          }
        }

        const prepared = prepareConfig(sourceConfig);
        setJobConfig(prepared);
        setGpuIDs(sourceGpuIDs);
        setExecutionTarget(sourceExecutionTarget);
        setSelectedTemplateId(sourceTemplateId);
        baselineSnapshotRef.current = snapshotJobTemplateState(prepared, sourceGpuIDs);
        setInitializationStatus('success');
      } catch (error: any) {
        console.error('Failed to initialize training form:', error);
        setInitializationError(
          error.response?.data?.error || error.message || 'Failed to initialize the training form.',
        );
        setInitializationStatus('error');
      }
    };

    initialize();
  }, [
    cloneId,
    datasetFetchStatus,
    gpuList,
    isGPUInfoLoaded,
    isSettingsLoaded,
    loadTemplate,
    prepareConfig,
    requestedTemplateId,
    runId,
    templateCatalog.default_template,
    templateCatalogStatus,
  ]);

  const hasUnsavedTemplateChanges = useCallback(() => {
    if (!baselineSnapshotRef.current) return false;
    return snapshotJobTemplateState(jobConfig, gpuIDs) !== baselineSnapshotRef.current;
  }, [gpuIDs, jobConfig]);

  const handleLoadTemplate = useCallback(
    async (id: string) => {
      if (
        hasUnsavedTemplateChanges() &&
        !window.confirm('Replace the current unsaved form settings with the selected template?')
      ) {
        return false;
      }
      const template = await loadTemplate(id);
      const prepared = prepareConfig(template.job_config);
      const nextGpuIDs = template.gpu_ids ?? (gpuList.length > 0 ? `${gpuList[0].index}` : null);
      setJobConfig(prepared);
      setGpuIDs(nextGpuIDs);
      setSelectedTemplateId(id);
      baselineSnapshotRef.current = snapshotJobTemplateState(prepared, nextGpuIDs);
      return true;
    },
    [gpuList, hasUnsavedTemplateChanges, loadTemplate, prepareConfig, setJobConfig],
  );

  const handleSaveTemplate = useCallback(
    async (id: string, template: JobTemplate, overwrite: boolean, makeDefault: boolean) => {
      await saveTemplate(id, template, overwrite);
      if (makeDefault) await setDefaultTemplate(id);
      setSelectedTemplateId(id);
      baselineSnapshotRef.current = snapshotJobTemplateState(jobConfig, gpuIDs);
    },
    [gpuIDs, jobConfig, saveTemplate, setDefaultTemplate],
  );

  const saveJob = async () => {
    if (status === 'saving' || initializationStatus !== 'success') return;
    setStatus('saving');

    apiClient
      .post('/api/jobs', {
        id: runId,
        name: jobConfig.config.name,
        gpu_ids: gpuIDs,
        execution_target: executionTarget,
        job_config: jobConfig,
      })
      .then(res => {
        setStatus('success');
        if (runId) {
          router.push(`/jobs/${runId}`);
        } else {
          router.push(`/jobs/${res.data.id}`);
        }
      })
      .catch(error => {
        if (error.response?.status === 409) {
          alert('Training name already exists. Please choose a different name.');
        } else {
          alert('Failed to save job. Please try again.');
        }
        console.log('Error saving training:', error);
      })
      .finally(() =>
        setTimeout(() => {
          setStatus('idle');
        }, 2000),
      );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    saveJob();
  };

  return (
    <>
      <TopBar>
        <div className="flex-shrink-0">
          <Button className="text-gray-500 dark:text-gray-300 px-2 sm:px-3 mt-1" onClick={() => history.back()}>
            <FaChevronLeft />
          </Button>
        </div>
        <div className="flex-shrink-0">
          <h1 className="text-base sm:text-lg truncate max-w-[120px] sm:max-w-none">
            {runId ? 'Edit Training Job' : 'New Training Job'}
          </h1>
        </div>
        <div className="flex-1"></div>
        {!runId && (
          <div className="mr-1 sm:mr-2 flex-shrink-0">
            <JobTemplateControls
              catalog={templateCatalog}
              catalogStatus={templateCatalogStatus}
              catalogError={templateCatalogError}
              currentTemplateId={selectedTemplateId}
              jobConfig={jobConfig}
              gpuIDs={gpuIDs}
              disabled={initializationStatus !== 'success'}
              onLoad={handleLoadTemplate}
              onSave={handleSaveTemplate}
              onSetDefault={async id => setDefaultTemplate(id)}
            />
          </div>
        )}
        {showAdvancedView && (
          <>
            <div className="hidden sm:block">
              <SelectInput
                value={executionTarget}
                onChange={value => setExecutionTarget(value === 'runpod_serverless' ? 'runpod_serverless' : 'local')}
                options={[
                  { value: 'local', label: 'Local GPU' },
                  ...(settings.RUNPOD_ENABLED || executionTarget === 'runpod_serverless'
                    ? [{ value: 'runpod_serverless', label: 'RunPod H100' }]
                    : []),
                ]}
              />
            </div>
            {executionTarget === 'local' && (
              <div className="hidden sm:block">
                <SelectInput
                  value={`${gpuIDs}`}
                  onChange={value => setGpuIDs(value)}
                  options={gpuList.map((gpu: any) => ({ value: `${gpu.index}`, label: `GPU #${gpu.index}` }))}
                />
              </div>
            )}
            <div className="hidden sm:block mx-4 bg-gray-200 dark:bg-gray-800 w-1 h-6"></div>
            <div className="hidden md:block">
              <Button className="text-gray-200 bg-gray-800 px-3 py-1 rounded-md" onClick={handleImportConfig}>
                Import Config
              </Button>
            </div>
            <div className="hidden md:block mx-4 bg-gray-200 dark:bg-gray-800 w-1 h-6"></div>
          </>
        )}
        {!showAdvancedView && (
          <>
            <div className="hidden sm:block">
              <SelectInput
                value={`${jobConfig?.config.process[0].type}`}
                onChange={value => {
                  // undo current job type changes
                  const currentOption = jobTypeOptions.find(
                    option => option.value === jobConfig?.config.process[0].type,
                  );
                  if (currentOption && currentOption.onDeactivate) {
                    setJobConfig(currentOption.onDeactivate(objectCopy(jobConfig)));
                  }
                  const option = jobTypeOptions.find(option => option.value === value);
                  if (option) {
                    if (option.onActivate) {
                      setJobConfig(option.onActivate(objectCopy(jobConfig)));
                    }
                    jobTypeOptions.forEach(opt => {
                      if (opt.value !== option.value && opt.onDeactivate) {
                        setJobConfig(opt.onDeactivate(objectCopy(jobConfig)));
                      }
                    });
                  }
                  setJobConfig(value, 'config.process[0].type');
                }}
                options={jobTypeOptions}
              />
            </div>
            <div className="hidden sm:block mx-4 bg-gray-200 dark:bg-gray-800 w-1 h-6"></div>
          </>
        )}

        <div className="pr-1 sm:pr-2 flex-shrink-0">
          <Button
            className="text-gray-200 bg-gray-800 px-2 sm:px-3 py-1 rounded-md text-xs sm:text-base"
            onClick={() => setShowAdvancedView(!showAdvancedView)}
          >
            <span className="sm:hidden">{showAdvancedView ? 'Simple' : 'Advanced'}</span>
            <span className="hidden sm:inline">{showAdvancedView ? 'Show Simple' : 'Show Advanced'}</span>
          </Button>
        </div>
        <div className="flex-shrink-0">
          <Button
            className="text-white bg-green-600 hover:bg-green-700 px-2 sm:px-3 py-1 rounded-md text-xs sm:text-base"
            onClick={() => saveJob()}
            disabled={status === 'saving' || initializationStatus !== 'success'}
          >
            {status === 'saving' ? (
              'Saving...'
            ) : (
              <>
                <span className="sm:hidden">{runId ? 'Update' : 'Create'}</span>
                <span className="hidden sm:inline">{runId ? 'Update Job' : 'Create Job'}</span>
              </>
            )}
          </Button>
        </div>
      </TopBar>

      <input
        ref={fileInputRef}
        type="file"
        accept=".yaml,.yml,.json,.jsonc"
        style={{ display: 'none' }}
        onChange={handleFileSelected}
      />

      {initializationError && (
        <div className="fixed left-1/2 top-16 z-40 w-[min(42rem,calc(100%-2rem))] -translate-x-1/2 rounded-md border border-red-700 bg-red-950 px-4 py-3 text-sm text-red-200 shadow-lg">
          {initializationError}
        </div>
      )}

      {showAdvancedView ? (
        <div className="pt-[48px] absolute top-0 left-0 w-full h-full overflow-auto">
          <AdvancedConfigEditor
            config={jobConfig}
            setConfig={setJobConfig}
            transformOnParse={(parsed: any) => prepareConfig(parsed)}
          />
        </div>
      ) : (
        <MainContent>
          <ErrorBoundary
            fallback={
              <div className="flex items-center justify-center h-64 text-lg text-red-600 font-medium bg-red-100 dark:bg-red-900/20 dark:text-red-400 border border-red-300 dark:border-red-700 rounded-lg">
                Advanced job detected. Please switch to advanced view to continue.
              </div>
            }
          >
            <SimpleJob
              jobConfig={jobConfig}
              setJobConfig={setJobConfig}
              status={status}
              handleSubmit={handleSubmit}
              runId={runId}
              gpuIDs={gpuIDs}
              setGpuIDs={setGpuIDs}
              gpuList={gpuList}
              executionTarget={executionTarget}
              setExecutionTarget={setExecutionTarget}
              runPodEnabled={settings.RUNPOD_ENABLED}
              datasetOptions={datasetOptions}
              isLoading={
                !isSettingsLoaded ||
                !isGPUInfoLoaded ||
                datasetFetchStatus !== 'success' ||
                initializationStatus !== 'success'
              }
            />
          </ErrorBoundary>

          <div className="pt-20"></div>
        </MainContent>
      )}
    </>
  );
}
