import crypto from 'crypto';

export const KREA2_TURBO_MODEL = {
  schemaVersion: 1,
  id: 'krea2-turbo-bf16-comfy-v1',
  repository: 'Comfy-Org/Krea-2',
  revision: '952f49d49653cb42e7d6cf7cbfad74738073ec7d',
  comfyUiCommit: '4800e78518ebb1f2a9443ea5418edbff6c3935f9',
  files: [
    {
      path: 'diffusion_models/krea2_turbo_bf16.safetensors',
      bytes: 26_283_332_608,
      sha256: '78bbf8f4165eda19cea3cb06c78089221932a39e2eed8af9da741f942c47ffb3',
    },
    {
      path: 'text_encoders/qwen3vl_4b_bf16.safetensors',
      bytes: 8_875_719_384,
      sha256: '36f3ff447ef59201722e8f9ce6020c9819fdcfba6aa2608c4e09b1c0ce114e34',
    },
    {
      path: 'vae/qwen_image_vae.safetensors',
      bytes: 253_806_246,
      sha256: 'a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f',
    },
  ],
} as const;

export const canonicalJson = (value: unknown): string => {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
};

export const sha256Text = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
export const KREA2_TURBO_MODEL_MANIFEST_SHA256 = sha256Text(canonicalJson(KREA2_TURBO_MODEL));
