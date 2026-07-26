# Krea 2 checkpoint export to ComfyUI

Krea 2 training jobs show a **Send a checkpoint to ComfyUI** action in the job toolbar. It:

1. Lists the job's final and step `.safetensors` checkpoints.
2. Copies the selected checkpoint to `models/loras/ai-toolkit/<job>/` without removing the training artifact.
3. Creates `AI Toolkit - <job> - <step>.json` in the default ComfyUI workflows folder.
4. Preselects the copied LoRA, the matching Krea 2 Raw or Turbo base, the job's first sample prompt and trigger word, and a fixed comparison seed.
5. Adds ComfyUI's built-in Resolution Selector, defaulted to 9:16 at approximately 576×1024. Select 16:9 for approximately 1024×576.

The server validates that the job uses the `krea2` architecture, that the checkpoint belongs to that job, and that the required Krea 2 base model, text encoder, and VAE are installed before copying anything.

## Configuration

The local deployment defaults to:

- `COMFYUI_ROOT=D:\ComfyUI-Krea2\ComfyUI`
- `COMFYUI_URL=https://comfyui.andreayalexclub.com/`

Override either value with an environment variable. They can also be stored as `COMFYUI_ROOT` and `COMFYUI_URL` rows in AI Toolkit's `Settings` table; environment variables take precedence.
