import React, { useEffect, useState } from 'react';
import {
  Checkbox,
  CreatableSelectInput,
  FormGroup,
  SelectInput,
  TextAreaInput,
  TextInput,
} from '@/components/formInputs';
import { CaptionJobConfig } from '@/types';
import { handleCaptionerTypeChange } from '@/helpers/captionJobConfig';
import {
  captionerTypes,
  defaultQtype,
  groupedCaptionerTypes,
  maxNewTokensOptions,
  maxResOptions,
  quantizationOptions,
} from '@/helpers/captionOptions';
import {
  CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION,
  bundledCaptionPromptTemplateCatalog,
  detectCaptionPromptTemplate,
  getCaptionPromptTemplate,
  normalizeCaptionPromptTemplateId,
} from '@/helpers/captionPromptTemplates';
import useCaptionPromptTemplates from '@/hooks/useCaptionPromptTemplates';

type Props = {
  jobConfig: CaptionJobConfig;
  setJobConfig: (value: any, key?: string) => void;
  gpuIDs: string | null;
  setGpuIDs: (value: string | null) => void;
  gpuList: any;
  showGPUSelect: boolean;
  geminiApiKeyConfigured: boolean;
  vertexConfigured: boolean;
  vertexProject: string;
  vertexLocation: string;
  isNewJob: boolean;
};

const CaptionSimpleJob: React.FC<Props> = ({
  jobConfig,
  setJobConfig,
  gpuIDs,
  setGpuIDs,
  gpuList,
  showGPUSelect,
  geminiApiKeyConfigured,
  vertexConfigured,
  vertexProject,
  vertexLocation,
  isNewJob,
}) => {
  const {
    catalog: captionPromptCatalog,
    status: captionPromptCatalogStatus,
    error: captionPromptCatalogError,
    save: saveCaptionPromptTemplate,
    setDefault: setDefaultCaptionPromptTemplate,
  } = useCaptionPromptTemplates();
  const [sourcePromptTemplateId, setSourcePromptTemplateId] = useState<string | null>(null);
  const [showPromptTemplateEditor, setShowPromptTemplateEditor] = useState(false);
  const [templateIdDraft, setTemplateIdDraft] = useState('');
  const [templateLabelDraft, setTemplateLabelDraft] = useState('');
  const [templateDescriptionDraft, setTemplateDescriptionDraft] = useState('');
  const [templateFamilyDraft, setTemplateFamilyDraft] = useState('');
  const [makeTemplateDefault, setMakeTemplateDefault] = useState(false);
  const [templateSaveError, setTemplateSaveError] = useState<string | null>(null);
  const [isSavingTemplate, setIsSavingTemplate] = useState(false);
  const promptTemplates =
    captionPromptCatalogStatus === 'success'
      ? captionPromptCatalog.templates
      : bundledCaptionPromptTemplateCatalog.templates;
  const captionPromptTemplateOptions = [
    { value: 'custom', label: 'Custom prompt' },
    ...promptTemplates.map(template => ({ value: template.id, label: template.label })),
  ];
  const selectedCaptionOption = captionerTypes.find(option => option.name === jobConfig.config.process[0].type);
  const isCloud = selectedCaptionOption?.executionTarget === 'cloud';
  const additionalSections = selectedCaptionOption?.additionalSections || [];
  const minNewTokens = selectedCaptionOption?.minNewTokens ?? 0;
  const newTokensOptions = maxNewTokensOptions.filter(option => parseInt(option.value) >= minNewTokens);
  const cloudBackend = jobConfig.config.process[0].caption.provider_options?.backend || 'developer';
  const effectiveVertexProject = jobConfig.config.process[0].caption.provider_options?.project || vertexProject;
  const effectiveVertexLocation =
    jobConfig.config.process[0].caption.provider_options?.location || vertexLocation || 'global';
  const cloudConfigured =
    cloudBackend === 'vertex' ? vertexConfigured && Boolean(effectiveVertexProject) : geminiApiKeyConfigured;
  const selectedPromptTemplateId =
    jobConfig.config.process[0].caption.caption_prompt_template ||
    detectCaptionPromptTemplate(jobConfig.config.process[0].caption.caption_prompt, promptTemplates);
  const selectedPromptTemplate = getCaptionPromptTemplate(selectedPromptTemplateId, promptTemplates);
  const sourcePromptTemplate = getCaptionPromptTemplate(sourcePromptTemplateId || undefined, promptTemplates);
  const displayedPromptTemplate = selectedPromptTemplate || sourcePromptTemplate;
  const displayedPromptTemplateId = selectedPromptTemplate?.id || sourcePromptTemplate?.id || 'custom';

  useEffect(() => {
    if (selectedPromptTemplateId !== 'custom') {
      setSourcePromptTemplateId(selectedPromptTemplateId);
    }
  }, [selectedPromptTemplateId]);

  const applyPromptTemplate = (templateId: string) => {
    setJobConfig(templateId, 'config.process[0].caption.caption_prompt_template');
    const template = getCaptionPromptTemplate(templateId, promptTemplates);
    if (template) {
      setSourcePromptTemplateId(template.id);
      setJobConfig(template.prompt, 'config.process[0].caption.caption_prompt');
    } else {
      setSourcePromptTemplateId(null);
    }
  };

  const applyDefaultPromptTemplate = () => {
    const defaultId = captionPromptCatalog.default_template || 'general';
    const template =
      getCaptionPromptTemplate(defaultId, promptTemplates) || getCaptionPromptTemplate('general', promptTemplates);
    if (template) applyPromptTemplate(template.id);
  };

  const openPromptTemplateEditor = () => {
    const source = displayedPromptTemplate;
    setTemplateIdDraft(source?.id || '');
    setTemplateLabelDraft(source?.label || '');
    setTemplateDescriptionDraft(source?.description || '');
    setTemplateFamilyDraft(source?.family || '');
    setMakeTemplateDefault(source?.id === captionPromptCatalog.default_template);
    setTemplateSaveError(null);
    setShowPromptTemplateEditor(true);
  };

  const savePromptTemplate = async () => {
    const id = normalizeCaptionPromptTemplateId(templateIdDraft);
    const prompt = jobConfig.config.process[0].caption.caption_prompt?.trim() || '';
    if (!id || !templateLabelDraft.trim() || !prompt) {
      setTemplateSaveError('Template ID, label, and caption prompt are required.');
      return;
    }

    const exists = captionPromptCatalog.templates.some(template => template.id === id);
    if (exists && !window.confirm(`Update the version-controlled caption prompt template "${id}"?`)) return;

    setIsSavingTemplate(true);
    setTemplateSaveError(null);
    try {
      await saveCaptionPromptTemplate(
        id,
        {
          schema_version: CAPTION_PROMPT_TEMPLATE_SCHEMA_VERSION,
          label: templateLabelDraft.trim(),
          ...(templateDescriptionDraft.trim() ? { description: templateDescriptionDraft.trim() } : {}),
          ...(templateFamilyDraft.trim() ? { family: templateFamilyDraft.trim() } : {}),
          prompt,
        },
        exists,
      );
      if (makeTemplateDefault) await setDefaultCaptionPromptTemplate(id);
      setJobConfig(id, 'config.process[0].caption.caption_prompt_template');
      setSourcePromptTemplateId(id);
      setShowPromptTemplateEditor(false);
    } catch (error: any) {
      setTemplateSaveError(error.response?.data?.error || error.message || 'Failed to save caption prompt template.');
    } finally {
      setIsSavingTemplate(false);
    }
  };

  return (
    <div className="text-sm text-gray-400">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <div>
          <SelectInput
            label="Captioner Type"
            value={jobConfig.config.process[0].type}
            onChange={value => {
              handleCaptionerTypeChange(jobConfig.config.process[0].type, value, jobConfig, setJobConfig);
              const nextCaptioner = captionerTypes.find(option => option.name === value);
              if (isNewJob && nextCaptioner?.supportsPromptTemplates) {
                applyDefaultPromptTemplate();
              }
            }}
            options={groupedCaptionerTypes}
          />
        </div>
        {showGPUSelect && !isCloud && (
          <div>
            <SelectInput
              label="GPU ID"
              value={`${gpuIDs}`}
              onChange={value => setGpuIDs(value)}
              options={gpuList.map((gpu: any) => ({ value: `${gpu.index}`, label: `GPU #${gpu.index}` }))}
            />
          </div>
        )}
      </div>
      {!isCloud && (
        <div className="mt-4">
          <CreatableSelectInput
            label="Name or Path"
            value={jobConfig.config.process[0].caption.model_name_or_path}
            docKey="config.process[0].caption.model_name_or_path"
            onChange={(value: string | null) => {
              if (value?.trim() === '') {
                value = null;
              }
              setJobConfig(value, 'config.process[0].caption.model_name_or_path');
            }}
            placeholder=""
            options={selectedCaptionOption?.name_or_path_options || []}
            required
          />
        </div>
      )}
      {isCloud && (
        <>
          <div className="mt-4">
            <SelectInput
              label="Google Backend"
              value={cloudBackend}
              onChange={value => {
                setJobConfig(value, 'config.process[0].caption.provider_options.backend');
                if (value === 'vertex') {
                  if (!jobConfig.config.process[0].caption.provider_options?.project && vertexProject) {
                    setJobConfig(vertexProject, 'config.process[0].caption.provider_options.project');
                  }
                  if (!jobConfig.config.process[0].caption.provider_options?.location) {
                    setJobConfig(vertexLocation || 'global', 'config.process[0].caption.provider_options.location');
                  }
                }
              }}
              options={[
                { value: 'developer', label: 'Gemini Developer API (API key)' },
                { value: 'vertex', label: 'Vertex AI / Gemini Enterprise (ADC + GCP billing)' },
              ]}
            />
          </div>
          <div className="mt-4">
            <CreatableSelectInput
              label="Provider Model"
              value={jobConfig.config.process[0].caption.model || 'gemini-3.1-pro-preview'}
              onChange={(value: string | null) =>
                setJobConfig(value?.trim() || null, 'config.process[0].caption.model')
              }
              placeholder="gemini-3.1-pro-preview"
              options={selectedCaptionOption?.name_or_path_options || []}
              required
            />
          </div>
          {cloudBackend === 'vertex' && (
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <TextInput
                label="Billing Project"
                value={effectiveVertexProject}
                onChange={value => setJobConfig(value.trim(), 'config.process[0].caption.provider_options.project')}
                placeholder="my-google-cloud-project"
              />
              <TextInput
                label="Vertex Location"
                value={effectiveVertexLocation}
                onChange={value =>
                  setJobConfig(value.trim().toLowerCase(), 'config.process[0].caption.provider_options.location')
                }
                placeholder="global"
              />
            </div>
          )}
          <div
            className={`mt-3 rounded border p-3 ${cloudConfigured ? 'border-green-900 bg-green-950/30' : 'border-orange-900 bg-orange-950/30'}`}
          >
            <p className={cloudConfigured ? 'text-green-400' : 'text-orange-400'}>
              {cloudBackend === 'vertex'
                ? `Vertex AI: ${cloudConfigured ? `configured for ${effectiveVertexProject}` : 'not configured in Settings'}`
                : `Gemini API key: ${geminiApiKeyConfigured ? 'configured' : 'not configured in Settings'}`}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Images are sent to Google for processing and may incur API charges. Credentials stay server-side. Vertex
              jobs record the project and location so their billing route is auditable.
            </p>
          </div>
        </>
      )}
      {additionalSections.includes('caption.model_name_or_path2') && (
        <div className="mt-4">
          <CreatableSelectInput
            label="Name or Path 2"
            value={jobConfig.config.process[0].caption.model_name_or_path2 || ''}
            onChange={(value: string | null) => {
              if (value?.trim() === '') {
                value = null;
              }
              setJobConfig(value, 'config.process[0].caption.model_name_or_path2');
            }}
            placeholder=""
            options={selectedCaptionOption?.name_or_path2_options || []}
          />
        </div>
      )}
      {additionalSections.includes('caption.fixed_caption') && (
        <div className="mt-4">
          <TextInput
            label="Fixed Caption"
            value={jobConfig.config.process[0].caption.fixed_caption || ''}
            onChange={value => {
              if (value?.trim() === '') {
                //@ts-ignore
                value = undefined;
              }
              setJobConfig(value, 'config.process[0].caption.fixed_caption');
            }}
            placeholder="Enter fixed caption (if you want the same caption for all audio files)"
          />
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <div>
          {!isCloud && (
            <SelectInput
              label="Quantize"
              value={jobConfig.config.process[0].caption.quantize ? jobConfig.config.process[0].caption.qtype : ''}
              onChange={value => {
                if (value === '') {
                  setJobConfig(false, 'config.process[0].caption.quantize');
                  value = defaultQtype;
                } else {
                  setJobConfig(true, 'config.process[0].caption.quantize');
                }
                setJobConfig(value, 'config.process[0].caption.qtype');
              }}
              options={quantizationOptions}
            />
          )}
          <div className="mt-4">
            <CreatableSelectInput
              label="Caption Extension"
              value={jobConfig.config.process[0].caption.caption_extension || 'txt'}
              onChange={value => {
                setJobConfig(value, 'config.process[0].caption.caption_extension');
              }}
              options={[
                { value: 'txt', label: 'txt' },
                { value: 'json', label: 'json' },
                { value: 'caption', label: 'caption' },
              ]}
            />
          </div>
          {additionalSections.includes('caption.max_res') && (
            <div className="mt-4">
              <SelectInput
                label="Max Resolution"
                value={`${jobConfig.config.process[0].caption.max_res || ''}`}
                onChange={value => {
                  const intVal = parseInt(value);
                  if (!isNaN(intVal)) {
                    setJobConfig(intVal, 'config.process[0].caption.max_res');
                  }
                }}
                options={maxResOptions}
              />
            </div>
          )}
          {additionalSections.includes('caption.max_new_tokens') && (
            <div className="mt-4">
              <SelectInput
                label="Max New Tokens"
                value={`${jobConfig.config.process[0].caption.max_new_tokens || ''}`}
                onChange={value => {
                  const intVal = parseInt(value);
                  if (!isNaN(intVal)) {
                    setJobConfig(intVal, 'config.process[0].caption.max_new_tokens');
                  }
                }}
                options={newTokensOptions}
              />
            </div>
          )}
          {isCloud && (
            <>
              <div className="mt-4">
                <SelectInput
                  label="Reasoning"
                  value={jobConfig.config.process[0].caption.provider_options?.thinking_level || 'high'}
                  onChange={value => setJobConfig(value, 'config.process[0].caption.provider_options.thinking_level')}
                  options={[
                    { value: 'low', label: 'Low' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'high', label: 'High (recommended)' },
                  ]}
                />
              </div>
              <div className="mt-4">
                <SelectInput
                  label="Media Resolution"
                  value={jobConfig.config.process[0].caption.provider_options?.media_resolution || 'high'}
                  onChange={value => setJobConfig(value, 'config.process[0].caption.provider_options.media_resolution')}
                  options={[
                    { value: 'low', label: 'Low' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'high', label: 'High (recommended)' },
                    { value: 'ultra_high', label: 'Ultra high (higher cost)' },
                  ]}
                />
              </div>
              <div className="mt-4">
                <SelectInput
                  label="Concurrent Requests"
                  value={`${jobConfig.config.process[0].caption.concurrency || 2}`}
                  onChange={value => setJobConfig(parseInt(value), 'config.process[0].caption.concurrency')}
                  options={[1, 2, 3, 4, 6, 8].map(value => ({ value: `${value}`, label: `${value}` }))}
                />
              </div>
              <div className="mt-4">
                <SelectInput
                  label="Max Output Tokens"
                  value={`${jobConfig.config.process[0].caption.max_output_tokens || 2048}`}
                  onChange={value => setJobConfig(parseInt(value), 'config.process[0].caption.max_output_tokens')}
                  options={[1024, 2048, 4096, 8192].map(value => ({ value: `${value}`, label: `${value}` }))}
                />
              </div>
            </>
          )}
        </div>
        <div>
          <FormGroup label="Options">
            {!isCloud && (
              <Checkbox
                label="Low VRAM"
                checked={jobConfig.config.process[0].caption.low_vram}
                onChange={value => setJobConfig(value, 'config.process[0].caption.low_vram')}
              />
            )}
            <Checkbox
              label="Recaption"
              checked={jobConfig.config.process[0].caption.recaption}
              onChange={value => setJobConfig(value, 'config.process[0].caption.recaption')}
            />
            {!isCloud && (
              <Checkbox
                label="Compile Models"
                checked={jobConfig.config.process[0].caption.compile || false}
                onChange={value => setJobConfig(value, 'config.process[0].caption.compile')}
              />
            )}
            {additionalSections.includes('caption.thinking') && (
              <Checkbox
                label="Thinking"
                checked={jobConfig.config.process[0].caption.thinking || false}
                onChange={value => setJobConfig(value, 'config.process[0].caption.thinking')}
              />
            )}
          </FormGroup>
        </div>
      </div>
      {additionalSections.includes('caption.caption_prompt') && (
        <div className="mt-4">
          {selectedCaptionOption?.supportsPromptTemplates && (
            <>
              <SelectInput
                label="Caption Prompt Preset"
                value={selectedPromptTemplateId}
                onChange={applyPromptTemplate}
                options={captionPromptTemplateOptions}
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={openPromptTemplateEditor}
                  className="rounded border border-gray-600 bg-gray-800 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700"
                >
                  Save prompt template
                </button>
                <button
                  type="button"
                  disabled={
                    selectedPromptTemplateId === 'custom' ||
                    selectedPromptTemplateId === captionPromptCatalog.default_template ||
                    captionPromptCatalogStatus !== 'success'
                  }
                  onClick={async () => {
                    try {
                      await setDefaultCaptionPromptTemplate(selectedPromptTemplateId);
                    } catch (error: any) {
                      setTemplateSaveError(
                        error.response?.data?.error || error.message || 'Failed to set the default prompt template.',
                      );
                    }
                  }}
                  className="rounded border border-gray-600 bg-gray-800 px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {selectedPromptTemplateId === captionPromptCatalog.default_template
                    ? 'Default template'
                    : 'Make default'}
                </button>
                <span className="text-xs text-gray-600">Stored in config/caption_prompt_templates</span>
              </div>
              <p className="mt-2 text-xs text-gray-500">
                {displayedPromptTemplate?.description ||
                  'Write your own captioning instructions below. Selecting a template replaces the prompt.'}
              </p>
              {displayedPromptTemplateId.startsWith('krea2_') && (
                <p className="mt-1 text-xs text-blue-400">
                  The generated caption keeps [trigger] literal so AI Toolkit can replace it with the training trigger.
                </p>
              )}
              {captionPromptCatalogError && (
                <p className="mt-2 text-xs text-orange-400">
                  {captionPromptCatalogError} Bundled prompts remain available as a fallback.
                </p>
              )}
              {captionPromptCatalog.issues.length > 0 && (
                <p className="mt-2 text-xs text-orange-400">
                  {captionPromptCatalog.issues.length} caption prompt template file
                  {captionPromptCatalog.issues.length === 1 ? '' : 's'} could not be loaded.
                </p>
              )}
              {templateSaveError && <p className="mt-2 text-xs text-red-400">{templateSaveError}</p>}
              {showPromptTemplateEditor && (
                <div className="mt-3 rounded-md border border-gray-700 bg-gray-900/60 p-4">
                  <p className="mb-3 text-sm font-medium text-gray-200">Save the current caption prompt</p>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <TextInput
                      label="Template ID"
                      value={templateIdDraft}
                      onChange={setTemplateIdDraft}
                      placeholder="my-caption-procedure-v1"
                    />
                    <TextInput
                      label="Label"
                      value={templateLabelDraft}
                      onChange={setTemplateLabelDraft}
                      placeholder="My caption procedure v1"
                    />
                    <TextInput
                      label="Family (optional)"
                      value={templateFamilyDraft}
                      onChange={setTemplateFamilyDraft}
                      placeholder="krea2"
                    />
                    <TextInput
                      label="Description (optional)"
                      value={templateDescriptionDraft}
                      onChange={setTemplateDescriptionDraft}
                      placeholder="What this prompt variation is testing"
                    />
                  </div>
                  <div className="mt-3">
                    <Checkbox
                      label="Make this the default caption prompt"
                      checked={makeTemplateDefault}
                      onChange={setMakeTemplateDefault}
                    />
                  </div>
                  <p className="mt-2 text-xs text-gray-500">
                    Use a new ID to preserve the current file as a separate version, or reuse an ID to update it.
                  </p>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setShowPromptTemplateEditor(false)}
                      className="rounded bg-gray-700 px-3 py-2 text-xs text-gray-200 hover:bg-gray-600"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={isSavingTemplate}
                      onClick={savePromptTemplate}
                      className="rounded bg-blue-600 px-3 py-2 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {isSavingTemplate ? 'Saving…' : 'Save template'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
          <div className={selectedCaptionOption?.supportsPromptTemplates ? 'mt-4' : ''}>
            <TextAreaInput
              label={
                selectedCaptionOption?.name === 'Ideogram4Captioner' ? 'Additional Instructions' : 'Caption Prompt'
              }
              value={jobConfig.config.process[0].caption.caption_prompt || ''}
              onChange={value => {
                setJobConfig(value, 'config.process[0].caption.caption_prompt');
                if (
                  selectedCaptionOption?.supportsPromptTemplates &&
                  value.trim() !== selectedPromptTemplate?.prompt.trim()
                ) {
                  setJobConfig('custom', 'config.process[0].caption.caption_prompt_template');
                }
              }}
              placeholder="Enter caption prompt"
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default CaptionSimpleJob;
