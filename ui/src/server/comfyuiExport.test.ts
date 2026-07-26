import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildKrea2ComparisonWorkflow,
  buildKrea2Workflow,
  exportAllCheckpointsToComfyUi,
  exportCheckpointToComfyUi,
  isKrea2JobConfig,
  listKrea2Checkpoints,
} from './comfyuiExport';

const temporaryRoots: string[] = [];

const makeRoot = async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aitk-comfyui-export-'));
  temporaryRoots.push(root);
  return root;
};

const jobConfig = (arch = 'krea2') =>
  JSON.stringify({
    config: {
      process: [
        {
          trigger_word: 'test trigger',
          model: { arch, name_or_path: 'krea/Krea-2-Raw' },
          sample: {
            samples: [{ prompt: 'portrait in [trigger]' }],
            neg: 'blurry',
            seed: 123,
            sample_steps: 24,
            guidance_scale: 3.5,
          },
        },
      ],
    },
  });

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.promises.rm(root, { recursive: true, force: true })));
});

describe('Krea 2 ComfyUI export', () => {
  it('recognizes Krea 2 configs without throwing on invalid JSON', () => {
    expect(isKrea2JobConfig(jobConfig())).toBe(true);
    expect(isKrea2JobConfig(jobConfig('flux'))).toBe(false);
    expect(isKrea2JobConfig('{')).toBe(false);
  });

  it('lists the final checkpoint first and step checkpoints newest-first', async () => {
    const trainingRoot = await makeRoot();
    const jobFolder = path.join(trainingRoot, 'test-job');
    await fs.promises.mkdir(jobFolder);
    await Promise.all([
      fs.promises.writeFile(path.join(jobFolder, 'test-job_000000250.safetensors'), '250'),
      fs.promises.writeFile(path.join(jobFolder, 'test-job_000001000.safetensors'), '1000'),
      fs.promises.writeFile(path.join(jobFolder, 'test-job.safetensors'), 'final'),
      fs.promises.writeFile(path.join(jobFolder, 'optimizer.pt'), 'ignored'),
    ]);

    const checkpoints = await listKrea2Checkpoints(trainingRoot, 'test-job', 1250);

    expect(checkpoints.map(item => item.fileName)).toEqual([
      'test-job.safetensors',
      'test-job_000001000.safetensors',
      'test-job_000000250.safetensors',
    ]);
    expect(checkpoints[0]).toMatchObject({ isFinal: true, step: 1250 });
    expect(checkpoints[1]).toMatchObject({ isFinal: false, step: 1000 });
  });

  it('builds a workflow with the exported LoRA, job prompts, and in-workflow aspect ratio selector', () => {
    const workflow = buildKrea2Workflow({
      jobName: 'test-job',
      checkpoint: {
        fileName: 'test-job_000001000.safetensors',
        label: 'Step 1,000',
        size: 4,
        step: 1000,
        isFinal: false,
      },
      loraName: path.join('ai-toolkit', 'test-job', 'test-job_000001000.safetensors'),
      jobConfig: jobConfig(),
    });

    expect(workflow.nodes.find(node => node.id === 3)?.widgets_values).toEqual([
      'krea2_raw_bf16.safetensors',
      'default',
    ]);
    expect(workflow.nodes.find(node => node.id === 4)?.widgets_values).toEqual([
      path.join('ai-toolkit', 'test-job', 'test-job_000001000.safetensors'),
      1,
    ]);
    expect(workflow.nodes.find(node => node.id === 6)?.widgets_values).toEqual(['portrait in test trigger']);
    expect(workflow.nodes.find(node => node.id === 8)?.widgets_values).toEqual([
      '9:16 (Portrait Widescreen)',
      0.56,
      16,
    ]);
    expect(workflow.nodes.find(node => node.id === 10)?.widgets_values).toEqual([
      123,
      'fixed',
      24,
      3.5,
      'res_multistep',
      'simple',
      1,
    ]);
  });

  it('builds one matched comparison with a no-LoRA baseline and every checkpoint', () => {
    const checkpoints = [
      {
        fileName: 'test-job.safetensors',
        label: 'Final',
        size: 5,
        step: 500,
        isFinal: true,
      },
      {
        fileName: 'test-job_000000250.safetensors',
        label: 'Step 250',
        size: 4,
        step: 250,
        isFinal: false,
      },
    ];
    const loraNames = checkpoints.map(checkpoint => path.join('ai-toolkit', 'test-job', checkpoint.fileName));

    const workflow = buildKrea2ComparisonWorkflow({
      jobName: 'test-job',
      checkpoints,
      loraNames,
      jobConfig: jobConfig(),
    });

    expect(workflow.groups?.map(group => group.title)).toEqual([
      'test-job - SHARED SETTINGS (edit once, then Queue once)',
      'NO LORA - BASELINE',
      'FINAL - STEP 500',
      'STEP 250',
    ]);
    expect(
      workflow.nodes.filter(node => node.type === 'LoraLoaderModelOnly').map(node => node.widgets_values?.[0]),
    ).toEqual(loraNames);
    expect(workflow.nodes.filter(node => node.type === 'KSampler').map(node => node.widgets_values)).toEqual([
      [123, 'fixed', 24, 3.5, 'res_multistep', 'simple', 1],
      [123, 'fixed', 24, 3.5, 'res_multistep', 'simple', 1],
      [123, 'fixed', 24, 3.5, 'res_multistep', 'simple', 1],
    ]);
    expect(workflow.nodes.find(node => node.id === 8)?.widgets_values).toEqual([
      '9:16 (Portrait Widescreen)',
      0.56,
      16,
    ]);
    expect(workflow.nodes.filter(node => node.type === 'SaveImage').map(node => node.widgets_values?.[0])).toEqual([
      'ai-toolkit/test-job/all-checkpoints/no-lora',
      'ai-toolkit/test-job/all-checkpoints/final-step-500',
      'ai-toolkit/test-job/all-checkpoints/step-250',
    ]);
    expect(workflow.links?.filter(link => link[1] === 3).length).toBe(3);
  });

  it('copies the checkpoint and writes a workflow into the configured ComfyUI folders', async () => {
    const trainingRoot = await makeRoot();
    const comfyRoot = await makeRoot();
    const jobFolder = path.join(trainingRoot, 'test-job');
    await fs.promises.mkdir(jobFolder);
    await fs.promises.writeFile(path.join(jobFolder, 'test-job_000000250.safetensors'), 'checkpoint-data');

    const requiredFiles = [
      path.join(comfyRoot, 'models', 'diffusion_models', 'krea2_raw_bf16.safetensors'),
      path.join(comfyRoot, 'models', 'text_encoders', 'qwen3vl_4b_bf16.safetensors'),
      path.join(comfyRoot, 'models', 'vae', 'qwen_image_vae.safetensors'),
    ];
    await fs.promises.mkdir(path.join(comfyRoot, 'models', 'loras'), { recursive: true });
    await fs.promises.mkdir(path.join(comfyRoot, 'user', 'default', 'workflows'), { recursive: true });
    for (const file of requiredFiles) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, 'model');
    }

    const result = await exportCheckpointToComfyUi({
      trainingRoot,
      comfyRoot,
      comfyUiUrl: 'https://comfy.example/',
      jobName: 'test-job',
      currentStep: 500,
      jobConfig: jobConfig(),
      checkpointFileName: 'test-job_000000250.safetensors',
    });

    expect(result).toEqual({
      mode: 'single',
      checkpoints: ['test-job_000000250.safetensors'],
      loraNames: [path.join('ai-toolkit', 'test-job', 'test-job_000000250.safetensors')],
      checkpoint: 'test-job_000000250.safetensors',
      loraName: path.join('ai-toolkit', 'test-job', 'test-job_000000250.safetensors'),
      workflowName: 'AI Toolkit - test-job - step-250.json',
      comfyUiUrl: 'https://comfy.example/',
    });
    await expect(
      fs.promises.readFile(
        path.join(comfyRoot, 'models', 'loras', 'ai-toolkit', 'test-job', 'test-job_000000250.safetensors'),
        'utf8',
      ),
    ).resolves.toBe('checkpoint-data');

    const workflow = JSON.parse(
      await fs.promises.readFile(path.join(comfyRoot, 'user', 'default', 'workflows', result.workflowName), 'utf8'),
    );
    expect(workflow.nodes.find((node: { id: number }) => node.id === 4).widgets_values[0]).toBe(result.loraName);

    await expect(
      exportCheckpointToComfyUi({
        trainingRoot,
        comfyRoot,
        comfyUiUrl: 'https://comfy.example/',
        jobName: 'test-job',
        currentStep: 500,
        jobConfig: jobConfig(),
        checkpointFileName: 'test-job_000000250.safetensors',
      }),
    ).resolves.toEqual(result);
  });

  it('copies every checkpoint and writes the all-checkpoint comparison workflow', async () => {
    const trainingRoot = await makeRoot();
    const comfyRoot = await makeRoot();
    const jobFolder = path.join(trainingRoot, 'test-job');
    await fs.promises.mkdir(jobFolder);
    await Promise.all([
      fs.promises.writeFile(path.join(jobFolder, 'test-job.safetensors'), 'final-data'),
      fs.promises.writeFile(path.join(jobFolder, 'test-job_000000250.safetensors'), 'step-data'),
    ]);

    const requiredFiles = [
      path.join(comfyRoot, 'models', 'diffusion_models', 'krea2_raw_bf16.safetensors'),
      path.join(comfyRoot, 'models', 'text_encoders', 'qwen3vl_4b_bf16.safetensors'),
      path.join(comfyRoot, 'models', 'vae', 'qwen_image_vae.safetensors'),
    ];
    await fs.promises.mkdir(path.join(comfyRoot, 'models', 'loras'), { recursive: true });
    await fs.promises.mkdir(path.join(comfyRoot, 'user', 'default', 'workflows'), { recursive: true });
    for (const file of requiredFiles) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, 'model');
    }

    const result = await exportAllCheckpointsToComfyUi({
      trainingRoot,
      comfyRoot,
      comfyUiUrl: 'https://comfy.example/',
      jobName: 'test-job',
      currentStep: 500,
      jobConfig: jobConfig(),
    });

    expect(result).toEqual({
      mode: 'comparison',
      checkpoints: ['test-job.safetensors', 'test-job_000000250.safetensors'],
      loraNames: [
        path.join('ai-toolkit', 'test-job', 'test-job.safetensors'),
        path.join('ai-toolkit', 'test-job', 'test-job_000000250.safetensors'),
      ],
      workflowName: 'AI Toolkit - test-job - all-checkpoints.json',
      comfyUiUrl: 'https://comfy.example/',
    });
    await expect(
      fs.promises.readFile(path.join(comfyRoot, 'models', 'loras', result.loraNames[0]), 'utf8'),
    ).resolves.toBe('final-data');
    await expect(
      fs.promises.readFile(path.join(comfyRoot, 'models', 'loras', result.loraNames[1]), 'utf8'),
    ).resolves.toBe('step-data');

    const workflow = JSON.parse(
      await fs.promises.readFile(path.join(comfyRoot, 'user', 'default', 'workflows', result.workflowName), 'utf8'),
    );
    expect(workflow.nodes.filter((node: { type: string }) => node.type === 'KSampler')).toHaveLength(3);
    expect(workflow.nodes.filter((node: { type: string }) => node.type === 'LoraLoaderModelOnly')).toHaveLength(2);
    expect(workflow.groups.map((group: { title: string }) => group.title)).toContain('NO LORA - BASELINE');
  });

  it('rejects checkpoint path traversal', async () => {
    const trainingRoot = await makeRoot();
    const comfyRoot = await makeRoot();
    await fs.promises.mkdir(path.join(comfyRoot, 'models', 'loras'), { recursive: true });
    await fs.promises.mkdir(path.join(comfyRoot, 'user', 'default', 'workflows'), { recursive: true });
    await expect(
      exportCheckpointToComfyUi({
        trainingRoot,
        comfyRoot,
        comfyUiUrl: 'https://comfy.example/',
        jobName: 'test-job',
        currentStep: 0,
        jobConfig: jobConfig(),
        checkpointFileName: '../outside.safetensors',
      }),
    ).rejects.toThrow('valid checkpoint');
  });
});
