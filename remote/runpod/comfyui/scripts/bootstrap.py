#!/usr/bin/env python3
import os
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from download_models import main as download_models
from status_file import update_status

REQUIRED_NODES = {
    "CLIPLoader",
    "VAELoader",
    "UNETLoader",
    "LoraLoaderModelOnly",
    "ModelSamplingAuraFlow",
    "CLIPTextEncode",
    "ResolutionSelector",
    "EmptySD3LatentImage",
    "KSampler",
    "VAEDecode",
    "SaveImage",
}


def get_json(route: str) -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:8189{route}", timeout=10) as response:
        return json.load(response)


def verify_comfy(process: subprocess.Popen, timeout_seconds: int = 180) -> None:
    deadline = time.monotonic() + timeout_seconds
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"ComfyUI exited with status {process.returncode} during startup")
        try:
            system = get_json("/system_stats")
            devices = system.get("devices", [])
            gpu_names = " ".join(
                str(device.get("name", "")) for device in devices if isinstance(device, dict)
            )
            if "H100" not in gpu_names.upper():
                raise RuntimeError("ComfyUI did not report an H100 device")
            object_info = get_json("/object_info")
            missing = sorted(REQUIRED_NODES - set(object_info))
            if missing:
                raise RuntimeError(f"ComfyUI is missing required core nodes: {', '.join(missing)}")
            update_status(
                phase="comfy_verified",
                comfyVerified=True,
                actualGpu=gpu_names[:300],
            )
            return
        except Exception as error:
            last_error = error
            time.sleep(2)
    raise RuntimeError(f"ComfyUI readiness validation timed out: {last_error}")


def main() -> None:
    try:
        update_status(
            workspaceId=os.environ["AITK_WORKSPACE_ID"],
            phase="bootstrap_starting",
            ready=False,
            errorCode=None,
            errorMessage=None,
        )
        download_models()
        comfy_root = Path("/workspace/comfy")
        user_root = comfy_root / "user"
        user_root.mkdir(parents=True, exist_ok=True)
        command = [
            sys.executable,
            "/opt/ComfyUI/main.py",
            "--listen",
            "127.0.0.1",
            "--port",
            "8189",
            "--base-directory",
            str(comfy_root),
            "--user-directory",
            str(user_root),
            "--disable-auto-launch",
        ]
        update_status(phase="comfy_starting")
        process = subprocess.Popen(command, cwd="/opt/ComfyUI")
        verify_comfy(process)
        return_code = process.wait()
        if return_code:
            raise RuntimeError(f"ComfyUI exited with status {return_code}")
    except Exception as error:
        update_status(
            phase="bootstrap_failed",
            ready=False,
            errorCode="MODEL_DOWNLOAD_FAILED" if "model" in str(error).lower() else "COMFY_START_FAILED",
            errorMessage=str(error)[:500],
        )
        raise


if __name__ == "__main__":
    main()
