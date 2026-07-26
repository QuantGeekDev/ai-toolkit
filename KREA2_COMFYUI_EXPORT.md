# Krea 2 checkpoint export to ComfyUI

Krea 2 training jobs show a **Create a ComfyUI checkpoint comparison** action in the job toolbar. By default it:

1. Lists the job's final and step `.safetensors` checkpoints.
2. Copies every checkpoint to `models/loras/ai-toolkit/<job>/` without removing the training artifacts.
3. Creates `AI Toolkit - <job> - all-checkpoints.json` in the default ComfyUI workflows folder.
4. Builds a no-LoRA baseline branch plus one branch for every checkpoint. All branches share the same base model, prompt, negative prompt, latent, seed, sampler, steps, and guidance so the LoRA checkpoint is the only changing variable.
5. Saves every result under `output/ai-toolkit/<job>/all-checkpoints/` when the workflow is queued once.
6. Adds ComfyUI's Resolution Selector, defaulted to 9:16 at approximately 576×1024. Select 16:9 for approximately 1024×576.

Choose **One checkpoint only** in the export dialog when a smaller workflow for an individual checkpoint is preferred.

The server validates that the job uses the `krea2` architecture, that the checkpoint belongs to that job, and that the required Krea 2 base model, text encoder, and VAE are installed before copying anything.

## Configuration

The local deployment defaults to:

- `COMFYUI_ROOT=D:\ComfyUI-Krea2\ComfyUI`
- `COMFYUI_URL=https://comfyui.andreayalexclub.com/`

Override either value with an environment variable. They can also be stored as `COMFYUI_ROOT` and `COMFYUI_URL` rows in AI Toolkit's `Settings` table; environment variables take precedence.
