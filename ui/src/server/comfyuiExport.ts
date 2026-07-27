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
  type?: string;
  title?: string;
  pos?: number[];
  size?: number[];
  order?: number;
  inputs?: Array<{ link?: number | null; [key: string]: unknown }>;
  outputs?: Array<{ links?: number[] | null; [key: string]: unknown }>;
  widgets_values?: unknown[];
  [key: string]: unknown;
};

type Krea2Workflow = {
  last_node_id?: number;
  last_link_id?: number;
  nodes: WorkflowNode[];
  links?: Array<[number, number, number, number, number, string]>;
  groups?: Array<{
    id: number;
    title: string;
    bounding?: number[];
    color?: string;
    font_size?: number;
    flags?: Record<string, unknown>;
  }>;
  config?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  version?: number;
};

export type ComfyUiCheckpoint = {
  fileName: string;
  label: string;
  size: number;
  step: number | null;
  isFinal: boolean;
};

export type ComfyUiExportResult = {
  mode: 'comparison' | 'single';
  checkpoints: string[];
  loraNames: string[];
  checkpoint?: string;
  loraName?: string;
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

const cloneTemplateNode = (id: number): WorkflowNode => {
  const template = JSON.parse(JSON.stringify(krea2WorkflowTemplate)) as Krea2Workflow;
  const node = JSON.parse(JSON.stringify(getNode(template, id))) as WorkflowNode;
  node.inputs = node.inputs?.map(input => ({ ...input, link: null }));
  node.outputs = node.outputs?.map(output => ({ ...output, links: null }));
  return node;
};

const workflowCheckpointLabel = (checkpoint: ComfyUiCheckpoint): string =>
  checkpoint.isFinal
    ? `FINAL - STEP ${checkpoint.step ?? '?'}`
    : checkpoint.step != null
      ? `STEP ${checkpoint.step}`
      : path.parse(checkpoint.fileName).name.toUpperCase();

const workflowCheckpointSlug = (checkpoint: ComfyUiCheckpoint): string =>
  checkpoint.isFinal
    ? `final-step-${checkpoint.step ?? 'custom'}`
    : checkpoint.step != null
      ? `step-${checkpoint.step}`
      : safePathSegment(path.parse(checkpoint.fileName).name, 'checkpoint');

const samplingSettings = (process: JobProcess) => {
  const turbo = baseModelFile(process).includes('turbo');
  return {
    shift: turbo ? 3.16 : 3,
    seed: finiteNumber(process.sample?.seed, 42),
    steps: finiteNumber(process.sample?.sample_steps, turbo ? 8 : 30),
    cfg: finiteNumber(process.sample?.guidance_scale, turbo ? 1 : 4),
    sampler: turbo ? 'euler' : 'res_multistep',
  };
};

const cloudJobConfig = (jobConfig: string): string => {
  const parsed = parseJobConfig(jobConfig);
  const process = parsed.config?.process?.[0];
  if (process?.model?.arch?.toLowerCase() !== 'krea2') {
    throw new ComfyUiExportError('Only Krea 2 training jobs can be sent to this ComfyUI workflow.');
  }
  return JSON.stringify({
    ...parsed,
    config: {
      ...parsed.config,
      process: [
        {
          ...process,
          model: { ...process.model, name_or_path: 'krea-ai/krea-2-turbo' },
          sample: {
            ...process.sample,
            seed: finiteNumber(process.sample?.seed, 42),
            sample_steps: 8,
            guidance_scale: 1,
          },
        },
        ...(parsed.config?.process?.slice(1) || []),
      ],
    },
  });
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
  const sampling = samplingSettings(process);
  const safeJobName = safePathSegment(jobName, 'krea2-job');
  const checkpointName = path.parse(checkpoint.fileName).name;
  const outputName = safePathSegment(checkpointName, 'checkpoint');

  getNode(workflow, 3).widgets_values = [baseModelFile(process), 'default'];

  const loraNode = getNode(workflow, 4);
  loraNode.title = `${safeJobName} — ${checkpoint.isFinal ? `final step ${checkpoint.step}` : `step ${checkpoint.step ?? '?'}`}`;
  loraNode.widgets_values = [loraName, 1];

  getNode(workflow, 5).widgets_values = [sampling.shift];
  getNode(workflow, 6).widgets_values = [firstPrompt(process)];
  getNode(workflow, 7).widgets_values = [process.sample?.neg || ''];
  getNode(workflow, 10).widgets_values = [
    sampling.seed,
    'fixed',
    sampling.steps,
    sampling.cfg,
    sampling.sampler,
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

export const buildKrea2ComparisonWorkflow = ({
  jobName,
  checkpoints,
  loraNames,
  jobConfig,
}: {
  jobName: string;
  checkpoints: ComfyUiCheckpoint[];
  loraNames: string[];
  jobConfig: string;
}): Krea2Workflow => {
  if (!checkpoints.length || checkpoints.length !== loraNames.length) {
    throw new ComfyUiExportError('The comparison workflow needs at least one matching checkpoint.');
  }

  const process = getKrea2Process(jobConfig);
  const sampling = samplingSettings(process);
  const safeJobName = safePathSegment(jobName, 'krea2-job');
  const nodes: WorkflowNode[] = [];
  const links: Array<[number, number, number, number, number, string]> = [];
  let nextLinkId = 1;

  const addNode = (
    templateId: number,
    id: number,
    pos: [number, number],
    title?: string,
    widgetsValues?: unknown[],
  ) => {
    const node = cloneTemplateNode(templateId);
    node.id = id;
    node.pos = pos;
    if (title != null) node.title = title;
    if (widgetsValues != null) node.widgets_values = widgetsValues;
    nodes.push(node);
    return node;
  };

  const connect = (fromNodeId: number, fromSlot: number, toNodeId: number, toSlot: number, type: string) => {
    const fromNode = nodes.find(node => node.id === fromNodeId);
    const toNode = nodes.find(node => node.id === toNodeId);
    const output = fromNode?.outputs?.[fromSlot];
    const input = toNode?.inputs?.[toSlot];
    if (!fromNode || !toNode || !output || !input) {
      throw new Error(`Could not connect Krea 2 comparison workflow nodes ${fromNodeId} and ${toNodeId}.`);
    }
    const linkId = nextLinkId++;
    output.links = [...(output.links || []), linkId];
    input.link = linkId;
    links.push([linkId, fromNodeId, fromSlot, toNodeId, toSlot, type]);
  };

  addNode(3, 3, [-1180, -220], 'SHARED KREA 2 BASE MODEL', [baseModelFile(process), 'default']);
  addNode(1, 1, [-1180, 260], 'SHARED KREA 2 TEXT ENCODER - keep type = krea2');
  addNode(2, 2, [-1180, 430], 'SHARED KREA 2 VAE');
  addNode(8, 8, [-760, -220], '1. ASPECT RATIO - choose 9:16 or 16:9');
  addNode(9, 9, [-300, -220], 'SHARED LATENT - used by every comparison branch', [576, 1024, 1]);
  addNode(6, 6, [-760, 100], "SHARED PROMPT - includes this job's trigger word", [firstPrompt(process)]);
  addNode(7, 7, [-760, 360], 'SHARED NEGATIVE PROMPT', [process.sample?.neg || '']);

  connect(1, 0, 6, 0, 'CLIP');
  connect(1, 0, 7, 0, 'CLIP');
  connect(8, 0, 9, 0, 'INT');
  connect(8, 1, 9, 1, 'INT');

  const groups: NonNullable<Krea2Workflow['groups']> = [
    {
      id: 1,
      title: `${safeJobName} - SHARED SETTINGS (edit once, then Queue once)`,
      bounding: [-1230, -280, 1260, 850],
      color: '#3f789e',
      font_size: 24,
      flags: {},
    },
  ];

  const branches: Array<{ checkpoint: ComfyUiCheckpoint | null; loraName: string | null }> = [
    { checkpoint: null, loraName: null },
    ...checkpoints.map((checkpoint, index) => ({ checkpoint, loraName: loraNames[index] })),
  ];

  branches.forEach((branch, index) => {
    const branchBaseId = 100 + index * 10;
    const top = -220 + index * 480;
    const loraId = branchBaseId;
    const samplingId = branchBaseId + 1;
    const samplerId = branchBaseId + 2;
    const decodeId = branchBaseId + 3;
    const saveId = branchBaseId + 4;
    const label = branch.checkpoint ? workflowCheckpointLabel(branch.checkpoint) : 'NO LORA - BASELINE';
    const slug = branch.checkpoint ? workflowCheckpointSlug(branch.checkpoint) : 'no-lora';

    let modelNodeId = 3;
    if (branch.checkpoint && branch.loraName) {
      addNode(4, loraId, [120, top], `${label} - strength 1.0`, [branch.loraName, 1]);
      connect(3, 0, loraId, 0, 'MODEL');
      modelNodeId = loraId;
    }

    addNode(5, samplingId, [560, top], `${label} - AuraFlow shift ${sampling.shift}`, [sampling.shift]);
    addNode(
      10,
      samplerId,
      [900, top],
      `${label} - SAME SEED ${sampling.seed} / ${sampling.steps} steps / CFG ${sampling.cfg}`,
      [sampling.seed, 'fixed', sampling.steps, sampling.cfg, sampling.sampler, 'simple', 1],
    );
    addNode(11, decodeId, [1270, top + 60], `${label} - DECODE`);
    const saveNode = addNode(12, saveId, [1530, top], `${label} - RESULT`, [
      `ai-toolkit/${safeJobName}/all-checkpoints/${slug}`,
    ]);
    saveNode.size = [420, 360];

    connect(modelNodeId, 0, samplingId, 0, 'MODEL');
    connect(samplingId, 0, samplerId, 0, 'MODEL');
    connect(6, 0, samplerId, 1, 'CONDITIONING');
    connect(7, 0, samplerId, 2, 'CONDITIONING');
    connect(9, 0, samplerId, 3, 'LATENT');
    connect(samplerId, 0, decodeId, 0, 'LATENT');
    connect(2, 0, decodeId, 1, 'VAE');
    connect(decodeId, 0, saveId, 0, 'IMAGE');

    groups.push({
      id: index + 2,
      title: label,
      bounding: [70, top - 45, 1920, 430],
      color: branch.checkpoint ? '#8a4baf' : '#39785b',
      font_size: 24,
      flags: {},
    });
  });

  nodes.forEach((node, index) => {
    node.order = index;
  });

  return {
    last_node_id: Math.max(...nodes.map(node => node.id)),
    last_link_id: nextLinkId - 1,
    nodes,
    links,
    groups,
    config: {},
    extra: {
      ds: {
        scale: 0.55,
        offset: [720, 280],
      },
    },
    version: 0.4,
  };
};

export const buildCloudKrea2Workflow = (options: Parameters<typeof buildKrea2Workflow>[0]): Krea2Workflow =>
  buildKrea2Workflow({ ...options, jobConfig: cloudJobConfig(options.jobConfig) });

export const buildCloudKrea2ComparisonWorkflow = (
  options: Parameters<typeof buildKrea2ComparisonWorkflow>[0],
): Krea2Workflow => buildKrea2ComparisonWorkflow({ ...options, jobConfig: cloudJobConfig(options.jobConfig) });

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

const assertKrea2Assets = async (comfyRoot: string, process: JobProcess) => {
  const baseModel = baseModelFile(process);
  await Promise.all([
    assertFile(path.join(comfyRoot, 'models', 'diffusion_models', baseModel), `Krea 2 base model (${baseModel})`),
    assertFile(
      path.join(comfyRoot, 'models', 'text_encoders', KREA2_TEXT_ENCODER),
      `Krea 2 text encoder (${KREA2_TEXT_ENCODER})`,
    ),
    assertFile(path.join(comfyRoot, 'models', 'vae', KREA2_VAE), `Krea 2 VAE (${KREA2_VAE})`),
  ]);
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

  await assertKrea2Assets(comfyRoot, process);

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
    mode: 'single',
    checkpoints: [checkpoint.fileName],
    loraNames: [loraName],
    checkpoint: checkpoint.fileName,
    loraName,
    workflowName,
    comfyUiUrl,
  };
};

export const exportAllCheckpointsToComfyUi = async ({
  trainingRoot,
  comfyRoot,
  comfyUiUrl,
  jobName,
  currentStep,
  jobConfig,
}: {
  trainingRoot: string;
  comfyRoot: string;
  comfyUiUrl: string;
  jobName: string;
  currentStep: number;
  jobConfig: string;
}): Promise<ComfyUiExportResult> => {
  const process = getKrea2Process(jobConfig);
  const installation = await inspectComfyUiInstallation(comfyRoot);
  if (!installation.available) {
    throw new ComfyUiExportError(installation.error || 'ComfyUI is unavailable.', 503);
  }

  const checkpoints = await listKrea2Checkpoints(trainingRoot, jobName, currentStep);
  if (!checkpoints.length) {
    throw new ComfyUiExportError('This job does not have any saved .safetensors checkpoints yet.', 404);
  }
  await assertKrea2Assets(comfyRoot, process);

  const safeJobName = safePathSegment(jobName, 'krea2-job');
  const loraNames = checkpoints.map(checkpoint => path.join('ai-toolkit', safeJobName, checkpoint.fileName));

  // Copy sequentially to avoid saturating the disk when a job contains many large checkpoints.
  for (const checkpoint of checkpoints) {
    const source = resolveInside(trainingRoot, jobName, checkpoint.fileName);
    const destination = resolveInside(comfyRoot, 'models', 'loras', 'ai-toolkit', safeJobName, checkpoint.fileName);
    await copyFileAtomically(source, destination);
  }

  const workflowName = safePathSegment(`AI Toolkit - ${safeJobName} - all-checkpoints`, 'AI Toolkit - Krea 2.json');
  const normalizedWorkflowName = workflowName.toLowerCase().endsWith('.json') ? workflowName : `${workflowName}.json`;
  const workflowDestination = resolveInside(comfyRoot, 'user', 'default', 'workflows', normalizedWorkflowName);
  const workflow = buildKrea2ComparisonWorkflow({
    jobName,
    checkpoints,
    loraNames,
    jobConfig,
  });
  await writeFileAtomically(workflowDestination, `${JSON.stringify(workflow, null, 2)}\n`);

  return {
    mode: 'comparison',
    checkpoints: checkpoints.map(checkpoint => checkpoint.fileName),
    loraNames,
    workflowName: normalizedWorkflowName,
    comfyUiUrl,
  };
};
