#!/usr/bin/env python3
import json
from pathlib import Path

manifest = json.loads(Path("/opt/aitk/model-manifest.json").read_text(encoding="utf-8"))
assert manifest["comfyUiCommit"] == "4800e78518ebb1f2a9443ea5418edbff6c3935f9"
assert [item["path"] for item in manifest["files"]] == [
    "diffusion_models/krea2_turbo_bf16.safetensors",
    "text_encoders/qwen3vl_4b_bf16.safetensors",
    "vae/qwen_image_vae.safetensors",
]
assert not Path("/opt/ComfyUI/custom_nodes/ComfyUI-Manager").exists()
print("Pinned ComfyUI image structure OK")
