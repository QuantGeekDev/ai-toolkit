#!/usr/bin/env python3
import hashlib
import json
import os
import time
from pathlib import Path

from huggingface_hub import hf_hub_download

from status_file import update_status

MANIFEST_PATH = Path("/opt/aitk/model-manifest.json")
MODEL_ROOT = Path("/workspace/comfy/models")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    token = os.environ.get("HF_TOKEN", "").strip() or None
    total = sum(int(item["bytes"]) for item in manifest["files"])
    completed = 0
    update_status(
        phase="downloading_models",
        modelBytesTotal=total,
        modelBytesVerified=0,
        modelManifestSha256=os.environ["AITK_MODEL_MANIFEST_SHA256"],
        imageDigest=os.environ["AITK_IMAGE_DIGEST"],
    )
    for item in manifest["files"]:
        destination = MODEL_ROOT / item["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(1, 4):
            try:
                downloaded = Path(
                    hf_hub_download(
                        repo_id=manifest["repository"],
                        filename=item["path"],
                        revision=manifest["revision"],
                        token=token,
                        local_dir=MODEL_ROOT,
                    )
                )
                if downloaded.resolve() != destination.resolve():
                    raise RuntimeError("Hugging Face download resolved outside the model directory")
                if destination.stat().st_size != int(item["bytes"]):
                    raise RuntimeError(f"byte length mismatch for {item['path']}")
                if sha256_file(destination) != item["sha256"]:
                    raise RuntimeError(f"SHA-256 mismatch for {item['path']}")
                break
            except Exception:
                destination.unlink(missing_ok=True)
                if attempt == 3:
                    raise
                time.sleep(min(30, 2**attempt))
        completed += int(item["bytes"])
        update_status(modelBytesVerified=completed)
    update_status(phase="models_verified", modelsVerified=True)


if __name__ == "__main__":
    main()
