from __future__ import annotations

import json
import os
import shutil

import runpod
import torch

from worker import run_remote_training


@runpod.serverless.register_fitness_check
def check_gpu_available():
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is unavailable")
    name = torch.cuda.get_device_name(0)
    os.environ["RUNPOD_GPU_NAME"] = name
    if os.environ.get("AITK_REQUIRE_H100", "1") == "1" and "H100" not in name.upper():
        raise RuntimeError(f"Expected an H100 worker, got {name}")


@runpod.serverless.register_fitness_check
def check_volume_and_disk():
    root = os.environ.get("AITK_RUNPOD_VOLUME_ROOT", "/runpod-volume/aitk")
    os.makedirs(root, exist_ok=True)
    if not os.access(root, os.W_OK):
        raise RuntimeError(f"RunPod network volume is not writable: {root}")
    free = shutil.disk_usage(root).free
    minimum = int(os.environ.get("AITK_MIN_FREE_BYTES", str(20 * 1024**3)))
    if free < minimum:
        raise RuntimeError(f"RunPod network volume has only {free} free bytes")
    image = os.environ.get("AITK_WORKER_IMAGE_DIGEST", "")
    if "@sha256:" not in image:
        raise RuntimeError("AITK_WORKER_IMAGE_DIGEST must identify the immutable running worker image")


def handler(job):
    def progress(event):
        compact = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
        runpod.serverless.progress_update(job, compact[:16_000])

    result = run_remote_training(job.get("input"), progress_callback=progress)
    # RunPod reserves this envelope when a long-running handler should be
    # discarded after the response. Keeping the result under job_results
    # follows the documented worker-refresh contract.
    return {"refresh_worker": True, "job_results": result}


runpod.serverless.start({"handler": handler})
