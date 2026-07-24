import React from 'react';
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

type Props = {
  jobConfig: CaptionJobConfig;
  setJobConfig: (value: any, key?: string) => void;
  gpuIDs: string | null;
  setGpuIDs: (value: string | null) => void;
  gpuList: any;
  showGPUSelect: boolean;
  geminiConfigured: boolean;
};

const CaptionSimpleJob: React.FC<Props> = ({
  jobConfig,
  setJobConfig,
  gpuIDs,
  setGpuIDs,
  gpuList,
  showGPUSelect,
  geminiConfigured,
}) => {
  const selectedCaptionOption = captionerTypes.find(option => option.name === jobConfig.config.process[0].type);
  const isCloud = selectedCaptionOption?.executionTarget === 'cloud';
  const additionalSections = selectedCaptionOption?.additionalSections || [];
  const minNewTokens = selectedCaptionOption?.minNewTokens ?? 0;
  const newTokensOptions = maxNewTokensOptions.filter(option => parseInt(option.value) >= minNewTokens);

  return (
    <div className="text-sm text-gray-400">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <div>
          <SelectInput
            label="Captioner Type"
            value={jobConfig.config.process[0].type}
            onChange={value => {
              handleCaptionerTypeChange(jobConfig.config.process[0].type, value, jobConfig, setJobConfig);
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
          <div
            className={`mt-3 rounded border p-3 ${geminiConfigured ? 'border-green-900 bg-green-950/30' : 'border-orange-900 bg-orange-950/30'}`}
          >
            <p className={geminiConfigured ? 'text-green-400' : 'text-orange-400'}>
              Gemini API key: {geminiConfigured ? 'configured' : 'not configured in Settings'}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Images are sent to Google for processing and may incur API charges. Credentials stay server-side and are
              never saved in this job.
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
          <TextAreaInput
            label="Caption Prompt"
            value={jobConfig.config.process[0].caption.caption_prompt || ''}
            onChange={value => {
              setJobConfig(value, 'config.process[0].caption.caption_prompt');
            }}
            placeholder="Enter caption prompt"
          />
        </div>
      )}
    </div>
  );
};

export default CaptionSimpleJob;
