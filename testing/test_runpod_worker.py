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
