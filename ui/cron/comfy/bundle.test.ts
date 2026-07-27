import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWorkspaceBundle, validateSafetensorsFile } from './bundle';
import {
  buildCloudKrea2ComparisonWorkflow,
  buildCloudKrea2Workflow,
  type ComfyUiCheckpoint,
} from '../../src/server/comfyuiExport';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.promises.rm(root, { recursive: true, force: true })));
});

const writeSafetensors = async (header: unknown, body = Buffer.from([1, 2, 3])) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aitk-comfy-test-'));
  roots.push(root);
  const file = path.join(root, 'checkpoint.safetensors');
  const encoded = Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(encoded.length));
  await fs.promises.writeFile(file, Buffer.concat([prefix, encoded, body]));
  return file;
};

const jobConfig = JSON.stringify({
  config: {
    process: [
      {
        trigger_word: 'subject',
        model: { arch: 'krea2', name_or_path: 'krea-ai/krea-2-raw' },
        sample: { prompts: ['subject portrait'], seed: 17, sample_steps: 30, guidance_scale: 4 },
      },
    ],
  },
});
const checkpoint: ComfyUiCheckpoint = {
  fileName: 'job_000001000.safetensors',
  label: 'Step 1000',
  size: 12,
  step: 1000,
  isFinal: false,
};

describe('Comfy workspace bundle safety', () => {
  it('accepts a structurally valid safetensors header', async () => {
    const file = await writeSafetensors({ tensor: { dtype: 'F16', shape: [1], data_offsets: [0, 2] } });
    await expect(validateSafetensorsFile(file)).resolves.toBeUndefined();
  });

  it('rejects empty and malformed safetensors metadata', async () => {
    await expect(validateSafetensorsFile(await writeSafetensors({ __metadata__: {} }))).rejects.toMatchObject({
      code: 'INVALID_SAFETENSORS',
    });
    const file = await writeSafetensors({ tensor: {} });
    const handle = await fs.promises.open(file, 'r+');
    await handle.write(Buffer.from([255, 255]), 0, 2, 8);
    await handle.close();
    await expect(validateSafetensorsFile(file)).rejects.toMatchObject({ code: 'INVALID_SAFETENSORS' });
  });

  it('forces the remote workflow to Turbo BF16 at fixed 8-step sampling', () => {
    const workflow = buildCloudKrea2Workflow({
      jobName: 'job',
      checkpoint,
      loraName: 'ai-toolkit/job/checkpoint.safetensors',
      jobConfig,
    });
    expect(workflow.nodes.find(node => node.id === 3)?.widgets_values).toEqual([
      'krea2_turbo_bf16.safetensors',
      'default',
    ]);
    expect(workflow.nodes.find(node => node.id === 5)?.widgets_values).toEqual([3.16]);
    expect(workflow.nodes.find(node => node.id === 10)?.widgets_values).toEqual([
      17,
      'fixed',
      8,
      1,
      'euler',
      'simple',
      1,
    ]);
  });

  it('keeps comparison baseline first and uses portable LoRA paths', () => {
    const workflow = buildCloudKrea2ComparisonWorkflow({
      jobName: 'job',
      checkpoints: [checkpoint],
      loraNames: ['ai-toolkit/job/checkpoint.safetensors'],
      jobConfig,
    });
    expect(workflow.groups?.[1]?.title).toContain('NO LORA');
    expect(workflow.nodes.find(node => node.type === 'LoraLoaderModelOnly')?.widgets_values?.[0]).not.toContain('\\');
  });

  it('replays an immutable staged bundle without replacing its snapshots', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aitk-comfy-replay-'));
    roots.push(root);
    const trainingRoot = path.join(root, 'training');
    const stagingDirectory = path.join(root, 'staging');
    const jobRoot = path.join(trainingRoot, 'job');
    await fs.promises.mkdir(jobRoot, { recursive: true });
    const source = path.join(jobRoot, checkpoint.fileName);
    const encoded = Buffer.from(JSON.stringify({ tensor: { dtype: 'F16', shape: [1], data_offsets: [0, 2] } }));
    const prefix = Buffer.alloc(8);
    prefix.writeBigUInt64LE(BigInt(encoded.length));
    await fs.promises.writeFile(source, Buffer.concat([prefix, encoded, Buffer.from([1, 2])]));
    const input = {
      workspace: {
        id: 'workspace-replay',
        export_mode: 'comparison',
        selected_checkpoint: null,
        created_at: new Date('2026-07-27T12:00:00Z'),
      } as any,
      job: { id: 'job-id', name: 'job', step: 1000, job_config: jobConfig } as any,
      trainingRoot,
      config: {
        stagingDirectory,
        minContainerDiskGb: 100,
        maxContainerDiskGb: 200,
        outputAllowanceGb: 20,
      } as any,
    };

    const first = await buildWorkspaceBundle(input);
    const before = await fs.promises.stat(first.artifacts[0].localPath);
    const second = await buildWorkspaceBundle(input);
    const after = await fs.promises.stat(second.artifacts[0].localPath);

    expect(second.manifestSha256).toBe(first.manifestSha256);
    expect(second.artifacts[0].sha256).toBe(first.artifacts[0].sha256);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });
});
