import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { Job } from '@prisma/client';
import { TOOLKIT_ROOT } from '../paths';
import { resolvePythonPath } from '../pythonPath';
import { RunPodConfig } from './settings';
import { safeErrorMessage } from './redact';

export type BundleValidationIssue = { code: string; message: string; path?: string };
export type BundleResult = {
  ok: boolean;
  bundlePath?: string;
  bundleName?: string;
  contentDigest?: string;
  archiveSha256?: string;
  archiveBytes?: number;
  manifest?: Record<string, any>;
  validation: {
    errors: BundleValidationIssue[];
    warnings: BundleValidationIssue[];
    summary: Record<string, any>;
  };
  error?: string;
};

const parseLastJsonLine = <T>(stdout: string): T | undefined => {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) return undefined;
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined;
  }
};

const run = (
  executable: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', chunk => (stderr += chunk));
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });

const git = async (args: string[]): Promise<string> => {
  const result = await run('git', args, TOOLKIT_ROOT);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${safeErrorMessage(result.stderr)}`);
  return result.stdout.trim();
};

const sourceRepositoryUrl = async (): Promise<string> => {
  const remotes = (await git(['remote']))
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);
  const remoteName = remotes.includes('fork') ? 'fork' : 'origin';
  return git(['remote', 'get-url', remoteName]).catch(() => '');
};

const architectureSlug = (jobConfig: any): string =>
  String(jobConfig?.config?.process?.[0]?.model?.arch || 'training')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'training';

const sanitizeRepositoryUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    // SSH scp syntax such as git@github.com:owner/repo.git has no embedded
    // HTTP bearer/query credential and is safe to record as-is.
    return trimmed;
  }
};

export const exportTrainingBundle = async (
  job: Job,
  config: RunPodConfig,
  options: { validateOnly?: boolean; allowDirty?: boolean } = {},
): Promise<BundleResult> => {
  let jobConfig: any;
  try {
    jobConfig = JSON.parse(job.job_config);
  } catch {
    throw new Error('Job configuration is not valid JSON.');
  }
  const [commit, branch, status, repository] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['branch', '--show-current']),
    git(['status', '--porcelain=v1', '--untracked-files=normal']),
    sourceRepositoryUrl(),
  ]);
  const dirty = status.length > 0;
  if (dirty && !options.allowDirty) {
    throw new Error(
      'Remote export requires a clean Git worktree so the experiment can be reproduced. Commit or stash changes first.',
    );
  }
  await fs.mkdir(config.bundleDirectory, { recursive: true });
  const request = {
    name: job.name,
    jobConfig,
    outputDirectory: config.bundleDirectory,
    bundleName: `${architectureSlug(jobConfig)}-v1`,
    exportEpoch: Math.floor(job.created_at.getTime() / 1000),
    workerImageDigest: config.workerImageDigest,
    modelRevision: process.env.AITK_MODEL_REVISION_OVERRIDE?.trim() || undefined,
    source: { repository: sanitizeRepositoryUrl(repository), branch, gitCommit: commit, dirty },
  };
  const requestPath = path.join(config.bundleDirectory, `.export-${job.id}-${process.pid}.json`);
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    const args = [path.join(TOOLKIT_ROOT, 'ui_scripts', 'training_bundle.py'), 'export', '--request', requestPath];
    if (options.validateOnly) args.push('--validate-only');
    const result = await run(resolvePythonPath(), args, TOOLKIT_ROOT);
    const parsed = parseLastJsonLine<BundleResult>(result.stdout);
    if (!parsed) throw new Error(`Bundle exporter failed: ${safeErrorMessage(result.stderr || result.stdout)}`);
    if (result.code !== 0 || !parsed.ok) return parsed;
    return parsed;
  } finally {
    await fs.rm(requestPath, { force: true });
  }
};

export const inspectTrainingBundle = async (bundlePath: string): Promise<Record<string, any>> => {
  const result = await run(
    resolvePythonPath(),
    [path.join(TOOLKIT_ROOT, 'ui_scripts', 'training_bundle.py'), 'inspect', '--bundle', bundlePath],
    TOOLKIT_ROOT,
  );
  const parsed = parseLastJsonLine<Record<string, any>>(result.stdout);
  if (result.code !== 0 || !parsed?.ok) {
    throw new Error(`Could not inspect prior training bundle: ${safeErrorMessage(result.stderr || result.stdout)}`);
  }
  return parsed;
};
