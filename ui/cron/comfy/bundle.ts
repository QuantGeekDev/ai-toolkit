import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ComfyWorkspace, Job } from '@prisma/client';
import {
  buildCloudKrea2ComparisonWorkflow,
  buildCloudKrea2Workflow,
  listKrea2Checkpoints,
  type ComfyUiCheckpoint,
} from '../../src/server/comfyuiExport';
import { canonicalJson, KREA2_TURBO_MODEL, KREA2_TURBO_MODEL_MANIFEST_SHA256 } from './modelManifest';
import type { RunPodComfyConfig } from './settings';

const MAX_SAFETENSORS_HEADER = 16 * 1024 * 1024;
const GIB = 1024 ** 3;

export class ComfyBundleError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type StagedArtifact = {
  role: 'lora' | 'workflow';
  displayName: string;
  localPath: string;
  remoteRelativePath: string;
  byteLength: bigint;
  sha256: string;
  sourceSize: bigint;
  sourceMtimeMs: bigint;
  step: number | null;
  isFinal: boolean;
};

export type WorkspaceBundle = {
  directory: string;
  workflowName: string;
  manifestPath: string;
  manifestSha256: string;
  artifacts: StagedArtifact[];
  checkpointCount: number;
  bytesPlanned: bigint;
  containerDiskGb: number;
};

const resolveInside = (root: string, ...parts: string[]) => {
  const candidate = path.resolve(root, ...parts);
  const relative = path.relative(path.resolve(root), candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new ComfyBundleError('PATH_TRAVERSAL', 'A workspace path escaped its allowed root.');
  return candidate;
};

const safeSegment = (value: string, fallback: string) =>
  value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim() || fallback;

export const hashFile = async (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const digest = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', chunk => digest.update(chunk));
    input.on('end', () => resolve(digest.digest('hex')));
  });

export const validateSafetensorsFile = async (filePath: string): Promise<void> => {
  const info = await fs.promises.lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ComfyBundleError('INVALID_SAFETENSORS', `${path.basename(filePath)} is not a regular checkpoint file.`);
  }
  if (info.size < 10) throw new ComfyBundleError('INVALID_SAFETENSORS', `${path.basename(filePath)} is truncated.`);
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const prefix = Buffer.alloc(8);
    await handle.read(prefix, 0, prefix.length, 0);
    const headerLength = Number(prefix.readBigUInt64LE());
    if (
      !Number.isSafeInteger(headerLength) ||
      headerLength < 2 ||
      headerLength > MAX_SAFETENSORS_HEADER ||
      8 + headerLength > info.size
    ) {
      throw new ComfyBundleError(
        'INVALID_SAFETENSORS',
        `${path.basename(filePath)} has an invalid safetensors header.`,
      );
    }
    const header = Buffer.alloc(headerLength);
    await handle.read(header, 0, headerLength, 8);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(header.toString('utf8'));
    } catch {
      throw new ComfyBundleError(
        'INVALID_SAFETENSORS',
        `${path.basename(filePath)} has malformed safetensors metadata.`,
      );
    }
    const tensors = Object.entries(parsed).filter(
      ([key, value]) => key !== '__metadata__' && value && typeof value === 'object',
    );
    if (!tensors.length)
      throw new ComfyBundleError('INVALID_SAFETENSORS', `${path.basename(filePath)} contains no tensors.`);
  } finally {
    await handle.close();
  }
};

const copySnapshot = async (
  source: string,
  destination: string,
): Promise<{ size: bigint; mtimeMs: bigint; sha256: string }> => {
  const before = await fs.promises.lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink())
    throw new ComfyBundleError('CHECKPOINT_CHANGED', 'A checkpoint is no longer a regular file.');
  const existing = await fs.promises.lstat(destination, { bigint: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== before.size) {
      throw new ComfyBundleError('STAGING_COLLISION', 'An existing staged checkpoint has the wrong identity.');
    }
    const [sourceDigest, stagedDigest, after] = await Promise.all([
      hashFile(source),
      hashFile(destination),
      fs.promises.lstat(source, { bigint: true }),
    ]);
    if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new ComfyBundleError(
        'CHECKPOINT_CHANGED',
        'A checkpoint changed while its immutable workspace snapshot was being verified.',
      );
    }
    if (sourceDigest !== stagedDigest) {
      throw new ComfyBundleError('STAGING_COLLISION', 'An existing staged checkpoint does not match its source.');
    }
    return { size: existing.size, mtimeMs: existing.mtimeMs, sha256: stagedDigest };
  }
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.partial`;
  try {
    await fs.promises.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
    const [after, staged, digest] = await Promise.all([
      fs.promises.lstat(source, { bigint: true }),
      fs.promises.lstat(temporary, { bigint: true }),
      hashFile(temporary),
    ]);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      staged.size !== after.size
    ) {
      throw new ComfyBundleError(
        'CHECKPOINT_CHANGED',
        'A checkpoint changed while its immutable workspace snapshot was being created.',
      );
    }
    await fs.promises.rename(temporary, destination);
    const committed = await fs.promises.lstat(destination, { bigint: true });
    return { size: committed.size, mtimeMs: committed.mtimeMs, sha256: digest };
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
};

export const calculateWorkspaceContainerDiskGb = (
  checkpointBytes: number,
  config: Pick<RunPodComfyConfig, 'minContainerDiskGb' | 'maxContainerDiskGb' | 'outputAllowanceGb'>,
): { containerDiskGb: number; requiredGb: number } => {
  const modelBytes = KREA2_TURBO_MODEL.files.reduce((total, item) => total + item.bytes, 0);
  // Checkpoints exist briefly in both restricted SFTP staging and their final
  // ComfyUI location. Output staging has the same bounded duplication.
  const requiredGb = Math.ceil(
    (modelBytes + checkpointBytes * 2 + config.outputAllowanceGb * 2 * GIB + 15 * GIB) / GIB,
  );
  return {
    containerDiskGb: Math.max(config.minContainerDiskGb, Math.min(config.maxContainerDiskGb, requiredGb)),
    requiredGb,
  };
};

const promptTrigger = (jobConfig: string): string => {
  try {
    return String(JSON.parse(jobConfig)?.config?.process?.[0]?.trigger_word || '');
  } catch {
    return '';
  }
};

export const buildWorkspaceBundle = async ({
  workspace,
  job,
  trainingRoot,
  config,
}: {
  workspace: ComfyWorkspace;
  job: Job;
  trainingRoot: string;
  config: RunPodComfyConfig;
}): Promise<WorkspaceBundle> => {
  const all = await listKrea2Checkpoints(trainingRoot, job.name, job.step);
  const checkpoints =
    workspace.export_mode === 'single' ? all.filter(item => item.fileName === workspace.selected_checkpoint) : all;
  if (!checkpoints.length)
    throw new ComfyBundleError('NO_CHECKPOINTS', 'No matching Krea 2 checkpoints are available.');

  const directory = resolveInside(config.stagingDirectory, workspace.id);
  await fs.promises.mkdir(directory, { recursive: true });
  const safeJobName = safeSegment(job.name, 'krea2-job');
  const sourceBytes = checkpoints.reduce((total, checkpoint) => total + checkpoint.size, 0);
  const stagingCapacity = await fs.promises.statfs(directory, { bigint: true });
  const stagingFreeBytes = stagingCapacity.bavail * stagingCapacity.bsize;
  if (BigInt(sourceBytes) > stagingFreeBytes) {
    throw new ComfyBundleError(
      'LOCAL_STAGING_FULL',
      `The local staging disk needs ${sourceBytes} bytes but has only ${stagingFreeBytes} bytes available.`,
    );
  }
  const loraRoot = resolveInside(directory, 'loras', 'ai-toolkit', safeJobName);
  const artifacts: StagedArtifact[] = [];
  for (const checkpoint of checkpoints) {
    const source = resolveInside(trainingRoot, job.name, checkpoint.fileName);
    await validateSafetensorsFile(source);
    const destination = resolveInside(loraRoot, checkpoint.fileName);
    const snapshot = await copySnapshot(source, destination);
    await validateSafetensorsFile(destination);
    artifacts.push({
      role: 'lora',
      displayName: checkpoint.fileName,
      localPath: destination,
      remoteRelativePath: path.posix.join('loras', 'ai-toolkit', safeJobName, checkpoint.fileName),
      byteLength: snapshot.size,
      sha256: snapshot.sha256,
      sourceSize: snapshot.size,
      sourceMtimeMs: snapshot.mtimeMs,
      step: checkpoint.step,
      isFinal: checkpoint.isFinal,
    });
  }

  const loraNames = artifacts.map(item => item.remoteRelativePath.replace(/^loras\//, ''));
  const workflow =
    workspace.export_mode === 'comparison'
      ? buildCloudKrea2ComparisonWorkflow({ jobName: job.name, checkpoints, loraNames, jobConfig: job.job_config })
      : buildCloudKrea2Workflow({
          jobName: job.name,
          checkpoint: checkpoints[0],
          loraName: loraNames[0],
          jobConfig: job.job_config,
        });
  for (const node of workflow.nodes) {
    if (node.type === 'SaveImage' && Array.isArray(node.widgets_values) && typeof node.widgets_values[0] === 'string') {
      node.widgets_values[0] = path.posix.join(
        'ai-toolkit',
        workspace.id,
        node.widgets_values[0].replace(/^ai-toolkit\//, ''),
      );
    }
  }
  const workflowName =
    workspace.export_mode === 'comparison'
      ? `AI Toolkit - ${safeJobName} - all-checkpoints.json`
      : `AI Toolkit - ${safeJobName} - ${safeSegment(path.parse(checkpoints[0].fileName).name, 'checkpoint')}.json`;
  const workflowPath = resolveInside(directory, 'workflows', workflowName);
  const workflowContents = `${canonicalJson(workflow)}\n`;
  await fs.promises.mkdir(path.dirname(workflowPath), { recursive: true });
  await fs.promises.writeFile(workflowPath, workflowContents, { flag: 'wx' }).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await fs.promises.readFile(workflowPath, 'utf8');
    if (existing !== workflowContents)
      throw new ComfyBundleError('STAGING_COLLISION', 'Existing staged workflow does not match the request.');
  });
  const workflowStats = await fs.promises.stat(workflowPath, { bigint: true });
  const workflowSha256 = await hashFile(workflowPath);
  artifacts.push({
    role: 'workflow',
    displayName: workflowName,
    localPath: workflowPath,
    remoteRelativePath: path.posix.join('workflows', workflowName),
    byteLength: workflowStats.size,
    sha256: workflowSha256,
    sourceSize: workflowStats.size,
    sourceMtimeMs: workflowStats.mtimeMs,
    step: null,
    isFinal: false,
  });

  const manifest = {
    schemaVersion: 1,
    workspaceId: workspace.id,
    job: { id: job.id, name: job.name, currentStep: job.step, triggerWord: promptTrigger(job.job_config) },
    export: {
      mode: workspace.export_mode,
      workflowFile: workflowName,
      workflowSha256,
      checkpointCount: checkpoints.length,
      includesNoLora: workspace.export_mode === 'comparison',
    },
    model: {
      id: KREA2_TURBO_MODEL.id,
      repository: KREA2_TURBO_MODEL.repository,
      revision: KREA2_TURBO_MODEL.revision,
      manifestSha256: KREA2_TURBO_MODEL_MANIFEST_SHA256,
    },
    files: artifacts.map(item => ({
      role: item.role,
      sourceName: item.displayName,
      remotePath: item.remoteRelativePath,
      bytes: Number(item.byteLength),
      sha256: item.sha256,
      step: item.step,
      isFinal: item.isFinal,
    })),
    createdAt: workspace.created_at.toISOString(),
  };
  const manifestContents = `${canonicalJson(manifest)}\n`;
  const manifestPath = resolveInside(directory, 'workspace-manifest.json');
  await fs.promises.writeFile(manifestPath, manifestContents);
  const manifestSha256 = crypto.createHash('sha256').update(manifestContents).digest('hex');
  const bytesPlanned = artifacts.reduce((total, item) => total + item.byteLength, BigInt(0));
  const loraBytes = Number(
    artifacts.filter(item => item.role === 'lora').reduce((total, item) => total + item.byteLength, BigInt(0)),
  );
  const { containerDiskGb, requiredGb } = calculateWorkspaceContainerDiskGb(loraBytes, config);
  if (requiredGb > config.maxContainerDiskGb) {
    throw new ComfyBundleError(
      'WORKSPACE_TOO_LARGE',
      `This workspace needs about ${requiredGb} GB, above the configured ${config.maxContainerDiskGb} GB limit.`,
    );
  }
  return {
    directory,
    workflowName,
    manifestPath,
    manifestSha256,
    artifacts,
    checkpointCount: checkpoints.length,
    bytesPlanned,
    containerDiskGb,
  };
};
