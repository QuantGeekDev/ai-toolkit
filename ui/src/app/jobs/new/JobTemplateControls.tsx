'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@headlessui/react';
import { Library, Save } from 'lucide-react';
import { Modal } from '@/components/Modal';
import { Checkbox, SelectInput, TextAreaInput, TextInput } from '@/components/formInputs';
import type { JobConfig } from '@/types';
import {
  JOB_TEMPLATE_SCHEMA_VERSION,
  JobTemplate,
  JobTemplateCatalog,
  normalizeJobTemplateId,
} from '@/helpers/jobTemplates';

type Props = {
  catalog: JobTemplateCatalog;
  catalogStatus: 'idle' | 'loading' | 'success' | 'error';
  catalogError: string | null;
  currentTemplateId: string | null;
  jobConfig: JobConfig;
  gpuIDs: string | null;
  disabled?: boolean;
  onLoad: (id: string) => Promise<boolean>;
  onSave: (id: string, template: JobTemplate, overwrite: boolean, makeDefault: boolean) => Promise<void>;
  onSetDefault: (id: string) => Promise<void>;
};

export default function JobTemplateControls({
  catalog,
  catalogStatus,
  catalogError,
  currentTemplateId,
  jobConfig,
  gpuIDs,
  disabled,
  onLoad,
  onSave,
  onSetDefault,
}: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [pickerId, setPickerId] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [family, setFamily] = useState('');
  const [makeDefault, setMakeDefault] = useState(false);
  const [busyAction, setBusyAction] = useState<'load' | 'save' | 'default' | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const templateOptions = useMemo(
    () =>
      catalog.templates.map(template => ({
        value: template.id,
        label: `${template.label}${catalog.default_template === template.id ? ' (default)' : ''}`,
      })),
    [catalog],
  );

  const selectedSummary = catalog.templates.find(template => template.id === pickerId);
  const normalizedId = normalizeJobTemplateId(templateId);
  const existingTemplate = catalog.templates.find(template => template.id === normalizedId);

  const selectSummary = (id: string) => {
    setPickerId(id);
    const summary = catalog.templates.find(template => template.id === id);
    if (!summary) return;
    setTemplateId(summary.id);
    setLabel(summary.label);
    setDescription(summary.description || '');
    setFamily(summary.family || '');
    setMakeDefault(catalog.default_template === summary.id);
    setMessage(null);
  };

  useEffect(() => {
    if (!isOpen) return;
    const initialId =
      (currentTemplateId && catalog.templates.some(template => template.id === currentTemplateId)
        ? currentTemplateId
        : null) ||
      catalog.default_template ||
      catalog.templates[0]?.id ||
      '';
    if (initialId) {
      selectSummary(initialId);
    } else {
      setPickerId('');
      setTemplateId(normalizeJobTemplateId(jobConfig.config.name));
      setLabel(jobConfig.config.name);
      setDescription('');
      setFamily('');
      setMakeDefault(false);
    }
  }, [isOpen]);

  const handleLoad = async () => {
    if (!pickerId) return;
    setBusyAction('load');
    setMessage(null);
    try {
      const loaded = await onLoad(pickerId);
      if (loaded) setIsOpen(false);
    } catch (error: any) {
      setMessage({ text: error.response?.data?.error || error.message || 'Failed to load template.', error: true });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSave = async () => {
    if (!normalizedId || !label.trim()) {
      setMessage({ text: 'Template ID and label are required.', error: true });
      return;
    }
    const overwrite = Boolean(existingTemplate);
    if (overwrite && !window.confirm(`Overwrite the tracked template "${normalizedId}" with the current form?`)) {
      return;
    }

    const template: JobTemplate = {
      schema_version: JOB_TEMPLATE_SCHEMA_VERSION,
      label: label.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(family.trim() ? { family: family.trim() } : {}),
      gpu_ids: gpuIDs,
      job_config: jobConfig,
    };

    setBusyAction('save');
    setMessage(null);
    try {
      await onSave(normalizedId, template, overwrite, makeDefault);
      setTemplateId(normalizedId);
      setPickerId(normalizedId);
      setMessage({ text: `Saved config/job_templates/${normalizedId}.json`, error: false });
    } catch (error: any) {
      setMessage({ text: error.response?.data?.error || error.message || 'Failed to save template.', error: true });
    } finally {
      setBusyAction(null);
    }
  };

  const handleSetDefault = async () => {
    if (!pickerId) return;
    setBusyAction('default');
    setMessage(null);
    try {
      await onSetDefault(pickerId);
      setMakeDefault(true);
      setMessage({ text: 'Default template updated.', error: false });
    } catch (error: any) {
      setMessage({ text: error.response?.data?.error || error.message || 'Failed to update default.', error: true });
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <>
      <Button
        className="inline-flex items-center gap-1 text-gray-200 bg-gray-800 hover:bg-gray-700 px-2 sm:px-3 py-1 rounded-md text-xs sm:text-base disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => setIsOpen(true)}
        disabled={disabled}
        title="Load or save a version-controlled job template"
      >
        <Library className="h-4 w-4" aria-hidden="true" />
        <span className="hidden md:inline">Templates</span>
      </Button>

      <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Job Templates" size="lg">
        <div className="space-y-6 text-sm text-gray-300">
          <section>
            <h4 className="font-medium text-gray-100">Load tracked settings</h4>
            <p className="mt-1 text-xs text-gray-500">
              Loading replaces the full form and GPU selection. The default loads automatically for a new job.
            </p>
            {catalogStatus === 'loading' || catalogStatus === 'idle' ? (
              <p className="mt-3 text-gray-400">Loading templates...</p>
            ) : templateOptions.length > 0 ? (
              <>
                <SelectInput
                  className="mt-3"
                  label="Template"
                  value={pickerId}
                  onChange={selectSummary}
                  options={templateOptions}
                  disabled={busyAction !== null}
                />
                {selectedSummary?.description && (
                  <p className="mt-2 rounded-md bg-gray-950/60 px-3 py-2 text-xs text-gray-400">
                    {selectedSummary.description}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    className="rounded-md bg-blue-700 px-3 py-1.5 text-white hover:bg-blue-600 disabled:opacity-40"
                    onClick={handleLoad}
                    disabled={!pickerId || busyAction !== null}
                  >
                    {busyAction === 'load' ? 'Loading...' : 'Load Template'}
                  </Button>
                  <Button
                    className="rounded-md bg-gray-700 px-3 py-1.5 text-white hover:bg-gray-600 disabled:opacity-40"
                    onClick={handleSetDefault}
                    disabled={!pickerId || catalog.default_template === pickerId || busyAction !== null}
                  >
                    {busyAction === 'default' ? 'Saving...' : 'Set as Default'}
                  </Button>
                </div>
              </>
            ) : (
              <p className="mt-3 rounded-md bg-gray-950/60 px-3 py-2 text-gray-400">
                No templates yet. Save the current form below to create the first one.
              </p>
            )}
          </section>

          <div className="border-t border-gray-700" />

          <section>
            <div className="flex items-center gap-2">
              <Save className="h-4 w-4 text-green-400" aria-hidden="true" />
              <h4 className="font-medium text-gray-100">Save current settings</h4>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Use a new ID for each training variation. Existing IDs require explicit overwrite confirmation.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextInput
                label="Template ID"
                value={templateId}
                onChange={value => setTemplateId(normalizeJobTemplateId(value))}
                placeholder="krea2-character-low-lr-v2"
                required
              />
              <TextInput
                label="Label"
                value={label}
                onChange={setLabel}
                placeholder="Krea 2 character — low LR v2"
                required
              />
              <TextInput label="Family" value={family} onChange={setFamily} placeholder="krea2-character" />
              <div className="flex items-end pb-1">
                <Checkbox label="Make this the default" checked={makeDefault} onChange={setMakeDefault} />
              </div>
            </div>
            <TextAreaInput
              className="mt-3"
              label="Description"
              value={description}
              onChange={setDescription}
              placeholder="What changed in this training procedure?"
              rows={3}
            />
            <div className="mt-3 flex items-center gap-3">
              <Button
                className="rounded-md bg-green-700 px-3 py-1.5 text-white hover:bg-green-600 disabled:opacity-40"
                onClick={handleSave}
                disabled={!normalizedId || !label.trim() || busyAction !== null}
              >
                {busyAction === 'save'
                  ? 'Saving...'
                  : existingTemplate
                    ? `Update ${normalizedId}`
                    : 'Save as New Template'}
              </Button>
              <span className="text-xs text-gray-500">config/job_templates/{normalizedId || 'template-id'}.json</span>
            </div>
          </section>

          {(catalogError || catalog.issues.length > 0 || message) && (
            <section className="space-y-2">
              {catalogError && <p className="rounded-md bg-red-950 px-3 py-2 text-red-200">{catalogError}</p>}
              {catalog.issues.map(issue => (
                <p key={`${issue.id}-${issue.error}`} className="rounded-md bg-yellow-950 px-3 py-2 text-yellow-200">
                  {issue.id}: {issue.error}
                </p>
              ))}
              {message && (
                <p
                  className={`rounded-md px-3 py-2 ${message.error ? 'bg-red-950 text-red-200' : 'bg-green-950 text-green-200'}`}
                >
                  {message.text}
                </p>
              )}
            </section>
          )}
        </div>
      </Modal>
    </>
  );
}
