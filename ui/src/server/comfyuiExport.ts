import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import krea2WorkflowTemplate from './comfyui/krea2-lora-workflow.json';

const KREA2_TEXT_ENCODER = 'qwen3vl_4b_bf16.safetensors';
const KREA2_VAE = 'qwen_image_vae.safetensors';

type JobProcess = {
  trigger_word?: string;
  model?: {
    arch?: string;
    name_or_path?: string;
  };
  sample?: {
    prompts?: Array<string | { prompt?: string }>;
    samples?: Array<string | { prompt?: string }>;
    neg?: string;
    seed?: number;
    guidance_scale?: number;
    sample_steps?: number;
  };
};

type JobConfig = {
  config?: {
    process?: JobProcess[];
  };
};

type WorkflowNode = {
  id: number;
  title?: string;
  widgets_values?: unknown[];
};

type Krea2Workflow = {
  nodes: WorkflowNode[];
  groups?: Array<{ id: number; title: string }>;
};

export type ComfyUiCheckpoint = {
  fileName: string;
  label: string;
  size: number;
  step: number | null;
  isFinal: boolean;
};

export type ComfyUiExportResult = {
  checkpoint: string;
  loraName: string;
  workflowName: string;
  comfyUiUrl: string;
};

export class ComfyUiExportError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ComfyUiExportError';
    this.status = status;
  }
}

const parseJobConfig = (jobConfig: string): JobConfig => {
  try {
    return JSON.parse(jobConfig) as JobConfig;
  } catch {
    throw new ComfyUiExportError('This job has an invalid configuration and cannot be exported.');
  }
};

const getKrea2Process = (jobConfig: string): JobProcess => {
  const process = parseJobConfig(jobConfig).config?.process?.[0];
  if (process?.model?.arch?.toLowerCase() !== 'krea2') {
    throw new ComfyUiExportError('Only Krea 2 training jobs can be sent to this ComfyUI workflow.');
  }
  return process;
};

export const isKrea2JobConfig = (jobConfig: string): boolean => {
  try {
    return parseJobConfig(jobConfig).config?.process?.[0]?.model?.arch?.toLowerCase() === 'krea2';
  } catch {
    return false;
  }
};

const isInside = (root: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const resolveInside = (root: string, ...segments: string[]): string => {
  const resolved = path.resolve(root, ...segments);
  if (!isInside(root, resolved)) {
    throw new ComfyUiExportError('The requested file path is outside the configured folder.');
  }
  return resolved;
};

const safePathSegment = (value: string, fallback: string): string => {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
};

const checkpointStep = (fileName: string): number | null => {
  const match = fileName.match(/_(\d{6,})\.safetensors$/i);
  return match ? Number.parseInt(match[1], 10) : null;
};

export const listKrea2Checkpoints = async (
  trainingRoot: string,
  jobName: string,
  currentStep: number,
): Promise<ComfyUiCheckpoint[]> => {
  if (path.basename(jobName) !== jobName || jobName === '.' || jobName === '..') {
    throw new ComfyUiExportError('The job name cannot be mapped to a training folder.');
  }

  const jobFolder = resolveInside(trainingRoot, jobName);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(jobFolder, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const checkpoints = await Promise.all(
    entries
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.safetensors'))
      .map(async entry => {
        const filePath = resolveInside(jobFolder, entry.name);
        const stats = await fs.promises.stat(filePath);
        const step = checkpointStep(entry.name);
        const isFinal = entry.name === `${jobName}.safetensors`;
        const label = isFinal
          ? `Final (step ${currentStep.toLocaleString()}) — ${entry.name}`
          : step != null
            ? `Step ${step.toLocaleString()} — ${entry.name}`
            : entry.name;
        return {
          fileName: entry.name,
          label,
          size: stats.size,
          step: isFinal ? currentStep : step,
          isFinal,
        };
      }),
  );

  return checkpoints.sort((a, b) => {
    if (a.isFinal !== b.isFinal) return a.isFinal ? -1 : 1;
    return (b.step ?? -1) - (a.step ?? -1) || a.fileName.localeCompare(b.fileName);
  });
};

const firstPrompt = (process: JobProcess): string => {
  const samples = process.sample?.samples ?? process.sample?.prompts ?? [];
  const first = samples[0];
  const prompt = typeof first === 'string' ? first : first?.prompt;
  const trigger = process.trigger_word?.trim() || '';

  if (prompt?.trim()) {
    return prompt
      .replace(/\[trigger\]/gi, trigger)
      .replace(/\s+/g, ' ')
      .trim();
  }
  return trigger ? `${trigger}, high quality detailed image` : 'high quality detailed image';
};

const finiteNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const baseModelFile = (process: JobProcess): string => {
  const modelName = process.model?.name_or_path?.toLowerCase() || '';
  return modelName.includes('turbo') ? 'krea2_turbo_bf16.safetensors' : 'krea2_raw_bf16.safetensors';
};

const getNode = (workflow: Krea2Workflow, id: number): WorkflowNode => {
  const node = workflow.nodes.find(item => item.id === id);
  if (!node) throw new Error(`Krea 2 workflow template is missing node ${id}.`);
  return node;
};

export const buildKrea2Workflow = ({
  jobName,
  checkpoint,
  loraName,
  jobConfig,
}: {
  jobName: string;
  checkpoint: ComfyUiCheckpoint;
  loraName: string;
  jobConfig: string;
}): Krea2Workflow => {
  const process = getKrea2Process(jobConfig);
  const workflow = JSON.parse(JSON.stringify(krea2WorkflowTemplate)) as Krea2Workflow;
  const safeJobName = safePathSegment(jobName, 'krea2-job');
  const checkpointName = path.parse(checkpoint.fileName).name;
  const outputName = safePathSegment(checkpointName, 'checkpoint');

  getNode(workflow, 3).widgets_values = [baseModelFile(process), 'default'];

  const loraNode = getNode(workflow, 4);
  loraNode.title = `${safeJobName} — ${checkpoint.isFinal ? `final step ${checkpoint.step}` : `step ${checkpoint.step ?? '?'}`}`;
  loraNode.widgets_values = [loraName, 1];

  getNode(workflow, 6).widgets_values = [firstPrompt(process)];
  getNode(workflow, 7).widgets_values = [process.sample?.neg || ''];
  getNode(workflow, 10).widgets_values = [
    finiteNumber(process.sample?.seed, 42),
    'fixed',
    finiteNumber(process.sample?.sample_steps, baseModelFile(process).includes('turbo') ? 8 : 30),
    finiteNumber(process.sample?.guidance_scale, baseModelFile(process).includes('turbo') ? 1 : 4),
    'res_multistep',
    'simple',
    1,
  ];
  getNode(workflow, 12).widgets_values = [`ai-toolkit/${safeJobName}/${outputName}`];

  const instructions = workflow.groups?.find(group => group.id === 2);
  if (instructions) {
    instructions.title = `${safeJobName}: edit prompt/strength, select 9:16 or 16:9, then Queue`;
  }
  return workflow;
};

const assertFile = async (filePath: string, label: string) => {
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) throw new Error();
  } catch {
    throw new ComfyUiExportError(`${label} is missing from the configured ComfyUI installation.`, 503);
  }
};

const replaceFile = async (temporary: string, destination: string) => {
  const backup = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.bak`);
  let hasBackup = false;
  try {
    try {
      await fs.promises.rename(destination, backup);
      hasBackup = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.promises.rename(temporary, destination);
    if (hasBackup) await fs.promises.rm(backup, { force: true });
  } catch (error) {
    if (hasBackup) {
      await fs.promises.rm(destination, { force: true });
      await fs.promises.rename(backup, destination);
    }
    throw error;
  }
};

const writeFileAtomically = async (destination: string, contents: string | Buffer) => {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, contents);
    await replaceFile(temporary, destination);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
};

const copyFileAtomically = async (source: string, destination: string) => {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    const before = await fs.promises.stat(source);
    await fs.promises.copyFile(source, temporary);
    const [after, copied] = await Promise.all([fs.promises.stat(source), fs.promises.stat(temporary)]);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || copied.size !== after.size) {
      throw new ComfyUiExportError(
        'The selected checkpoint changed while it was being copied. Wait for the save to finish and try again.',
      );
    }
    await replaceFile(temporary, destination);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
};

export const inspectComfyUiInstallation = async (comfyRoot: string) => {
  if (!comfyRoot || !path.isAbsolute(comfyRoot)) {
    return {
      available: false,
      error: 'COMFYUI_ROOT is not configured with an absolute path.',
    };
  }
  const requiredDirectories = [
    path.join(comfyRoot, 'models', 'loras'),
    path.join(comfyRoot, 'user', 'default', 'workflows'),
  ];
  const missing: string[] = [];
  for (const directory of requiredDirectories) {
    try {
      const stats = await fs.promises.stat(directory);
      if (!stats.isDirectory()) missing.push(directory);
    } catch {
      missing.push(directory);
    }
  }
  return {
    available: missing.length === 0,
    error: missing.length ? 'The configured ComfyUI model or workflow folder is unavailable.' : null,
  };
};

export const exportCheckpointToComfyUi = async ({
  trainingRoot,
  comfyRoot,
  comfyUiUrl,
  jobName,
  currentStep,
  jobConfig,
  checkpointFileName,
}: {
  trainingRoot: string;
  comfyRoot: string;
  comfyUiUrl: string;
  jobName: string;
  currentStep: number;
  jobConfig: string;
  checkpointFileName: string;
}): Promise<ComfyUiExportResult> => {
  const process = getKrea2Process(jobConfig);
  const installation = await inspectComfyUiInstallation(comfyRoot);
  if (!installation.available) {
    throw new ComfyUiExportError(installation.error || 'ComfyUI is unavailable.', 503);
  }
  if (
    !checkpointFileName ||
    path.basename(checkpointFileName) !== checkpointFileName ||
    !checkpointFileName.toLowerCase().endsWith('.safetensors')
  ) {
    throw new ComfyUiExportError('Select a valid checkpoint from this job.');
  }

  const checkpoints = await listKrea2Checkpoints(trainingRoot, jobName, currentStep);
  const checkpoint = checkpoints.find(item => item.fileName === checkpointFileName);
  if (!checkpoint) {
    throw new ComfyUiExportError('The selected checkpoint no longer exists in this job.', 404);
  }

  const baseModel = baseModelFile(process);
  await Promise.all([
    assertFile(path.join(comfyRoot, 'models', 'diffusion_models', baseModel), `Krea 2 base model (${baseModel})`),
    assertFile(
      path.join(comfyRoot, 'models', 'text_encoders', KREA2_TEXT_ENCODER),
      `Krea 2 text encoder (${KREA2_TEXT_ENCODER})`,
    ),
    assertFile(path.join(comfyRoot, 'models', 'vae', KREA2_VAE), `Krea 2 VAE (${KREA2_VAE})`),
  ]);

  const safeJobName = safePathSegment(jobName, 'krea2-job');
  const source = resolveInside(trainingRoot, jobName, checkpoint.fileName);
  const loraDestination = resolveInside(comfyRoot, 'models', 'loras', 'ai-toolkit', safeJobName, checkpoint.fileName);
  const loraName = path.join('ai-toolkit', safeJobName, checkpoint.fileName);
  const workflowBaseName = safePathSegment(
    `AI Toolkit - ${safeJobName} - ${checkpoint.isFinal ? `final-step-${checkpoint.step}` : `step-${checkpoint.step ?? 'custom'}`}`,
    'AI Toolkit - Krea 2',
  );
  const workflowName = `${workflowBaseName}.json`;
  const workflowDestination = resolveInside(comfyRoot, 'user', 'default', 'workflows', workflowName);
  const workflow = buildKrea2Workflow({ jobName, checkpoint, loraName, jobConfig });

  await copyFileAtomically(source, loraDestination);
  await writeFileAtomically(workflowDestination, `${JSON.stringify(workflow, null, 2)}\n`);

  return {
    checkpoint: checkpoint.fileName,
    loraName,
    workflowName,
    comfyUiUrl,
  };
};
