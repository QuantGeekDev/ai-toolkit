import gzip
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

import yaml
from PIL import Image

from toolkit.training_bundle import (
    BundleError,
    BundleValidationError,
    export_training_bundle,
    inspect_training_bundle,
    safe_extract_training_bundle,
    validate_training_bundle_request,
)


COMMIT = "1" * 40
MODEL_REVISION = "2" * 40
IMAGE_DIGEST = f"example.invalid/ai-toolkit@sha256:{'3' * 64}"


def job_config(dataset: Path, *, seed=42):
    process = {
        "type": "diffusion_trainer",
        "training_folder": r"C:\local\output",
        "sqlite_db_path": r"C:\local\aitk_db.db",
        "device": "cuda",
        "training_seed": seed,
        "trigger_word": "nightmarish analog broadcast style",
        "datasets": [
            {
                "folder_path": str(dataset),
                "caption_ext": "txt",
                "controls": [],
                "mask_path": None,
            }
        ],
        "train": {"steps": 100},
        "model": {"name_or_path": "krea/Krea-2-Raw", "arch": "krea2"},
    }
    return {"job": "extension", "config": {"name": "test-style", "process": [process]}}


def request(dataset: Path, output: Path, **overrides):
    value = {
        "name": "test-style",
        "jobConfig": job_config(dataset),
        "outputDirectory": str(output),
        "bundleName": "krea2-v1",
        "exportEpoch": 1_700_000_000,
        "workerImageDigest": IMAGE_DIGEST,
        "modelRevision": MODEL_REVISION,
        "source": {"repository": "https://example.invalid/repo.git", "gitCommit": COMMIT, "dirty": False},
    }
    value.update(overrides)
    return value


class TrainingBundleTests(unittest.TestCase):
    def make_pair(self, root: Path, stem="0001", caption="[trigger], a grainy hallway"):
        Image.new("RGB", (24, 16), "navy").save(root / f"{stem}.png")
        (root / f"{stem}.txt").write_text(caption, encoding="utf-8")

    def test_cli_resolves_toolkit_package_outside_repository(self):
        script = Path(__file__).resolve().parents[1] / "ui_scripts" / "training_bundle.py"
        environment = os.environ.copy()
        environment.pop("PYTHONPATH", None)
        with tempfile.TemporaryDirectory() as folder:
            result = subprocess.run(
                [sys.executable, str(script), "--help"],
                cwd=folder,
                env=environment,
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Create or verify an AI Toolkit training bundle", result.stdout)

    def test_export_is_deterministic_and_paths_are_portable(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            dataset = root / "dataset"
            output = root / "bundles"
            dataset.mkdir()
            self.make_pair(dataset)
            first = export_training_bundle(request(dataset, output))
            second = export_training_bundle(request(dataset, output))
            self.assertEqual(first["archiveSha256"], second["archiveSha256"])
            self.assertEqual(first["contentDigest"], second["contentDigest"])
            self.assertEqual(first["bundlePath"], second["bundlePath"])

            with tarfile.open(first["bundlePath"], "r:gz") as archive:
                config = yaml.safe_load(archive.extractfile("train.template.yaml").read())
                manifest_bytes = archive.extractfile("manifest.json").read()
                names = archive.getnames()
            process = config["config"]["process"][0]
            self.assertEqual(process["datasets"][0]["folder_path"], "${AITK_DATASET_DIR}")
            self.assertEqual(process["training_folder"], "${AITK_OUTPUT_ROOT}")
            self.assertEqual(process["sqlite_db_path"], "${AITK_CONTROL_DB}")
            self.assertEqual(process["model"]["name_or_path"], "${AITK_MODEL_DIR}")
            self.assertNotIn(b"C:\\\\local", manifest_bytes)
            self.assertNotIn(str(dataset).encode("utf-8"), manifest_bytes)
            self.assertEqual(names, ["dataset/0001.png", "dataset/0001.txt", "train.template.yaml", "manifest.json"])
            self.assertTrue(inspect_training_bundle(first["bundlePath"])["ok"])

    def test_validation_rejects_refusal_duplicate_stem_and_missing_seed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            dataset = root / "dataset"
            dataset.mkdir()
            self.make_pair(dataset, caption="I cannot help with that request")
            Image.new("RGB", (8, 8), "black").save(dataset / "0001.jpg")
            invalid = request(dataset, root / "out")
            invalid["jobConfig"] = job_config(dataset, seed=None)
            report, _ = validate_training_bundle_request(invalid)
            codes = {item["code"] for item in report["errors"]}
            self.assertIn("TRAINING_SEED_REQUIRED", codes)
            self.assertIn("DUPLICATE_IMAGE_STEM", codes)
            self.assertIn("CAPTION_PROVIDER_ERROR", codes)
            with self.assertRaises(BundleValidationError):
                export_training_bundle(invalid)

    def test_validation_rejects_dirty_source_and_mutable_worker_image(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            dataset = root / "dataset"
            dataset.mkdir()
            self.make_pair(dataset)
            invalid = request(dataset, root / "out", workerImageDigest="example/image:latest")
            invalid["source"]["dirty"] = True
            report, _ = validate_training_bundle_request(invalid)
            codes = {item["code"] for item in report["errors"]}
            self.assertIn("SOURCE_TREE_DIRTY", codes)
            self.assertIn("WORKER_IMAGE_MUTABLE", codes)

    def test_safe_extract_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            archive_path = root / "malicious.tar.gz"
            with archive_path.open("wb") as raw:
                with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as compressed:
                    with tarfile.open(fileobj=compressed, mode="w") as archive:
                        data = b"bad"
                        info = tarfile.TarInfo("../escape.txt")
                        info.size = len(data)
                        archive.addfile(info, io.BytesIO(data))
            with self.assertRaises(BundleError):
                safe_extract_training_bundle(archive_path, root / "extract")
            self.assertFalse((root / "escape.txt").exists())


if __name__ == "__main__":
    unittest.main()
