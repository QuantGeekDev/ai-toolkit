import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, KREA2_TURBO_MODEL, KREA2_TURBO_MODEL_MANIFEST_SHA256, sha256Text } from './modelManifest';

describe('Krea 2 Turbo BF16 model contract', () => {
  it('matches the remote image manifest exactly', () => {
    const remote = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), '..', 'remote', 'runpod', 'comfyui', 'model-manifest.json'), 'utf8'),
    );
    expect(remote).toEqual(KREA2_TURBO_MODEL);
    expect(sha256Text(canonicalJson(remote))).toBe(KREA2_TURBO_MODEL_MANIFEST_SHA256);
  });

  it('contains only the pinned unquantized Turbo BF16 stack', () => {
    const names = KREA2_TURBO_MODEL.files.map(item => item.path).join(' ');
    expect(names).toContain('krea2_turbo_bf16.safetensors');
    expect(names).toContain('qwen3vl_4b_bf16.safetensors');
    expect(names).not.toMatch(/raw|fp8|gguf/i);
  });
});
