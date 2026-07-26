import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from remote.runpod.worker import (
    RemoteWorkerError,
    WorkerRun,
    _initialize_control_db,
    _read_control_db,
    _redact_message,
    _set_stop,
    _verify_model_inventory,
    validate_request,
)


def valid_request():
    return {
        "schemaVersion": 1,
        "executionId": "execution-1",
        "requestKey": f"sha256:{'1' * 64}",
        "bundleKey": "bundles/content/archive.tar.gz",
        "bundleContentDigest": f"sha256:{'2' * 64}",
        "bundleArchiveSha256": "3" * 64,
        "runPrefix": "runs/execution-1",
        "expectedWorkerImageDigest": f"example/image@sha256:{'4' * 64}",
    }


class RunPodWorkerTests(unittest.TestCase):
    def _run_terminal_worker_fixture(self, *, stopped: bool = False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        request = valid_request()
        archive = root / request["bundleKey"]
        archive.parent.mkdir(parents=True)
        archive.write_bytes(b"deterministic training bundle fixture")
        request["bundleArchiveSha256"] = hashlib.sha256(archive.read_bytes()).hexdigest()
        source_commit = "a" * 40
        events = []
        worker = WorkerRun(request, root, root, events.append)

        def extract_fixture(_archive, destination):
            destination.mkdir(parents=True)
            manifest = {
                "schemaVersion": 1,
                "contentDigest": request["bundleContentDigest"],
                "source": {"gitCommit": source_commit},
                "model": {"repository": "example/model", "revision": "b" * 40},
                "training": {"trainingSeed": 42},
            }
            (destination / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            config = {
                "config": {
                    "name": "remote-smoke",
                    "process": [
                        {
                            "type": "diffusion_trainer",
                            "training_folder": "${AITK_OUTPUT_ROOT}",
                            "sqlite_db_path": "${AITK_CONTROL_DB}",
                            "datasets": [{"folder_path": "${AITK_DATASET_DIR}"}],
                            "model": {"name_or_path": "${AITK_MODEL_DIR}", "revision": "b" * 40},
                            "train": {"steps": 1},
                        }
                    ],
                }
            }
            (destination / "train.template.yaml").write_text(json.dumps(config), encoding="utf-8")
            (destination / "dataset").mkdir()
            (destination / "validation").mkdir()

        def materialize_fixture(volume_root, repository, revision, _progress):
            model_dir = volume_root / "models" / "fixture"
            model_dir.mkdir(parents=True)
            (model_dir / ".aitk-model-ready.json").write_text(
                json.dumps({"repository": repository, "revision": revision, "files": []}),
                encoding="utf-8",
            )
            return model_dir

        class FinishedProcess:
            def __init__(self):
                self.stdout = ["training fixture complete\n"]

            def poll(self):
                return 0

            def wait(self):
                return 0

        def start_fixture_process(*_args, **kwargs):
            output_dir = Path(kwargs["env"]["AITK_JOB_OUTPUT_DIR"])
            (output_dir / "remote-smoke.safetensors").write_bytes(b"verified LoRA")
            connection = sqlite3.connect(worker.run_dir / "work" / "control.db")
            try:
                connection.execute(
                    "UPDATE Job SET step = 1, status = ?, stop = ? WHERE id = ?",
                    ("stopped" if stopped else "completed", 1 if stopped else 0, worker.execution_id),
                )
                connection.commit()
            finally:
                connection.close()
            return FinishedProcess()

        environment = {
            "AITK_WORKER_IMAGE_DIGEST": request["expectedWorkerImageDigest"],
            "AITK_SOURCE_COMMIT": source_commit,
            "RUNPOD_GPU_NAME": "NVIDIA H100 80GB HBM3",
        }
        with (
            patch.dict(os.environ, environment, clear=False),
            patch("remote.runpod.worker.safe_extract_training_bundle", side_effect=extract_fixture),
            patch("remote.runpod.worker._materialize_model", side_effect=materialize_fixture),
            patch("remote.runpod.worker.subprocess.Popen", side_effect=start_fixture_process),
        ):
            result = worker.run()
        return worker, result, events

    def test_successful_run_writes_verified_result_before_complete_marker(self):
        worker, result, events = self._run_terminal_worker_fixture()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["finalStep"], 1)
        self.assertTrue((worker.run_dir / "result.json").is_file())
        self.assertTrue((worker.run_dir / "artifacts.json").is_file())
        self.assertTrue((worker.run_dir / "COMPLETE").is_file())
        self.assertFalse((worker.run_dir / "STOPPED").exists())
        self.assertEqual(events[-1]["phase"], "completed")
        marker_hash = (worker.run_dir / "COMPLETE").read_text(encoding="ascii").strip()
        self.assertEqual(marker_hash, result["artifactIndexSha256"])

    def test_gracefully_stopped_run_writes_stopped_marker(self):
        worker, result, events = self._run_terminal_worker_fixture(stopped=True)
        self.assertEqual(result["status"], "stopped")
        self.assertTrue((worker.run_dir / "STOPPED").is_file())
        self.assertFalse((worker.run_dir / "COMPLETE").exists())
        self.assertEqual(events[-1]["phase"], "stopped")

    def test_request_is_fail_closed(self):
        request = valid_request()
        request["unexpectedSecret"] = "no"
        with self.assertRaisesRegex(RemoteWorkerError, "Unknown input"):
            validate_request(request)
        request = valid_request()
        request["bundleKey"] = "../escape"
        with self.assertRaisesRegex(RemoteWorkerError, "safe relative"):
            validate_request(request)

    def test_worker_error_redaction_removes_controller_credentials(self):
        message = _redact_message(
            f"bad rps_{'s' * 32} for user_{'u' * 32}; Bearer {'b' * 32}&X-Amz-Signature=signature"
        )
        self.assertNotIn("rps_", message)
        self.assertNotIn("user_", message)
        self.assertNotIn("signature", message)
        self.assertIn("[REDACTED]", message)

    def test_control_database_is_private_and_supports_stop(self):
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / "control.db"
            _initialize_control_db(database, "execution-1", 2500)
            self.assertEqual(_read_control_db(database, "execution-1")["total_steps"], 2500)
            _set_stop(database, "execution-1")
            self.assertEqual(_read_control_db(database, "execution-1")["stop"], 1)
            connection = sqlite3.connect(database)
            try:
                columns = {row[1] for row in connection.execute("PRAGMA table_info(Job)")}
            finally:
                connection.close()
            self.assertTrue({"id", "status", "stop", "step", "total_steps", "save_now", "sample_now"} <= columns)

    def test_claim_is_idempotent_and_conflicts_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            worker = WorkerRun(valid_request(), root, root, lambda _event: None)
            self.assertIsNone(worker._claim())
            duplicate = worker._claim()
            self.assertEqual(duplicate["status"], "duplicate")
            conflicting = valid_request()
            conflicting["requestKey"] = f"sha256:{'9' * 64}"
            with self.assertRaisesRegex(RemoteWorkerError, "different request"):
                WorkerRun(conflicting, root, root, lambda _event: None)._claim()

    def test_stale_identical_claim_can_be_recovered(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            worker = WorkerRun(valid_request(), root, root, lambda _event: None)
            self.assertIsNone(worker._claim())
            claim = worker.run_dir / "claim.json"
            value = json.loads(claim.read_text(encoding="utf-8"))
            value["claimedAt"] = 1
            claim.write_text(json.dumps(value), encoding="utf-8")
            with patch.dict(os.environ, {"AITK_CLAIM_STALE_SECONDS": "1"}):
                self.assertIsNone(WorkerRun(valid_request(), root, root, lambda _event: None)._claim())
            self.assertEqual(len(list(worker.run_dir.glob("claim.stale.*.json"))), 1)

    def test_model_cache_inventory_detects_tampering(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            model_file = root / "transformer" / "weights.bin"
            model_file.parent.mkdir()
            model_file.write_bytes(b"known model bytes")
            import hashlib

            metadata = {
                "files": [
                    {
                        "path": "transformer/weights.bin",
                        "bytes": model_file.stat().st_size,
                        "sha256": hashlib.sha256(model_file.read_bytes()).hexdigest(),
                    }
                ]
            }
            _verify_model_inventory(root, metadata)
            model_file.write_bytes(b"tampered")
            with self.assertRaisesRegex(RemoteWorkerError, "checksum mismatch"):
                _verify_model_inventory(root, metadata)

    def test_live_checkpoint_is_published_only_after_its_save_step(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            worker = WorkerRun(valid_request(), root, root, lambda _event: None)
            output = root / "output"
            output.mkdir()
            checkpoint = output / "style_000000250.safetensors"
            checkpoint.write_bytes(b"complete checkpoint")
            worker._publish_completed_checkpoints(output, 250)
            index_path = worker.run_dir / "state" / "live-artifacts.json"
            self.assertEqual(json.loads(index_path.read_text(encoding="utf-8"))["artifacts"], [])
            worker._publish_completed_checkpoints(output, 251)
            artifacts = json.loads(index_path.read_text(encoding="utf-8"))["artifacts"]
            self.assertEqual(artifacts[0]["step"], 250)
            self.assertEqual(artifacts[0]["path"], checkpoint.name)
            self.assertEqual(len(artifacts[0]["sha256"]), 64)


if __name__ == "__main__":
    unittest.main()
