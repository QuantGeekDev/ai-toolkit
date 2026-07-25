from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import platform
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Callable

import yaml

from toolkit.training_bundle import BundleError, safe_extract_training_bundle


ProgressCallback = Callable[[dict[str, Any]], None]
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
ARCHIVE_RE = re.compile(r"^[0-9a-f]{64}$")


class RemoteWorkerError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _redact_message(value: Any) -> str:
    message = str(value)
    message = re.sub(r"\brp[as]_[A-Za-z0-9_-]{16,}\b", "[REDACTED]", message)
    message = re.sub(r"\buser_[A-Za-z0-9_-]{16,}\b", "[REDACTED]", message)
    message = re.sub(r"\bBearer\s+[A-Za-z0-9._~+/-]{12,}", "Bearer [REDACTED]", message, flags=re.I)
    message = re.sub(
        r"([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&\s]+",
        r"\1[REDACTED]",
        message,
        flags=re.I,
    )
    return message[:1000]


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, ensure_ascii=False, sort_keys=True, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="ascii", newline="\n") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _hash_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def _safe_relative_key(value: Any, field: str) -> Path:
    raw = str(value or "").replace("\\", "/").strip("/")
    parts = raw.split("/") if raw else []
    if not parts or any(not ID_RE.fullmatch(part) or part in {".", ".."} for part in parts):
        raise RemoteWorkerError("REQUEST_INVALID", f"{field} is not a safe relative object key")
    return Path(*parts)


def validate_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RemoteWorkerError("REQUEST_INVALID", "input must be an object")
    allowed = {
        "schemaVersion",
        "executionId",
        "requestKey",
        "bundleKey",
        "bundleContentDigest",
        "bundleArchiveSha256",
        "runPrefix",
        "expectedWorkerImageDigest",
        "resumePrefix",
    }
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise RemoteWorkerError("REQUEST_INVALID", f"Unknown input field(s): {', '.join(unknown)}")
    if value.get("schemaVersion") != 1:
        raise RemoteWorkerError("REQUEST_INVALID", "Unsupported request schemaVersion")
    if not ID_RE.fullmatch(str(value.get("executionId") or "")):
        raise RemoteWorkerError("REQUEST_INVALID", "executionId is invalid")
    if not DIGEST_RE.fullmatch(str(value.get("requestKey") or "")):
        raise RemoteWorkerError("REQUEST_INVALID", "requestKey is invalid")
    if not DIGEST_RE.fullmatch(str(value.get("bundleContentDigest") or "")):
        raise RemoteWorkerError("REQUEST_INVALID", "bundleContentDigest is invalid")
    if not ARCHIVE_RE.fullmatch(str(value.get("bundleArchiveSha256") or "")):
        raise RemoteWorkerError("REQUEST_INVALID", "bundleArchiveSha256 is invalid")
    image = str(value.get("expectedWorkerImageDigest") or "")
    if len(image) > 512 or not re.search(r"@sha256:[0-9a-f]{64}$", image):
        raise RemoteWorkerError("REQUEST_INVALID", "expectedWorkerImageDigest is not immutable")
    _safe_relative_key(value.get("bundleKey"), "bundleKey")
    _safe_relative_key(value.get("runPrefix"), "runPrefix")
    if value.get("resumePrefix"):
        _safe_relative_key(value.get("resumePrefix"), "resumePrefix")
    return value


def _initialize_control_db(path: Path, execution_id: str, total_steps: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    try:
        connection.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS Job (
              id TEXT PRIMARY KEY,
              status TEXT NOT NULL DEFAULT 'running',
              stop INTEGER NOT NULL DEFAULT 0,
              return_to_queue INTEGER NOT NULL DEFAULT 0,
              step INTEGER NOT NULL DEFAULT 0,
              total_steps INTEGER,
              info TEXT NOT NULL DEFAULT '',
              speed_string TEXT NOT NULL DEFAULT '',
              save_now INTEGER NOT NULL DEFAULT 0,
              sample_now INTEGER NOT NULL DEFAULT 0
            );
            """
        )
        connection.execute(
            """
            INSERT INTO Job(id, status, total_steps, info)
            VALUES(?, 'running', ?, 'Starting remote job')
            ON CONFLICT(id) DO UPDATE SET total_steps=excluded.total_steps
            """,
            (execution_id, total_steps),
        )
        connection.commit()
    finally:
        connection.close()


def _read_control_db(path: Path, execution_id: str) -> dict[str, Any]:
    connection = None
    try:
        connection = sqlite3.connect(path, timeout=2)
        connection.row_factory = sqlite3.Row
        row = connection.execute(
            "SELECT status, stop, step, total_steps, info, speed_string FROM Job WHERE id = ?",
            (execution_id,),
        ).fetchone()
        if row is None:
            return {}
        return dict(row)
    except sqlite3.Error:
        return {}
    finally:
        if connection is not None:
            connection.close()


def _set_stop(path: Path, execution_id: str) -> None:
    connection = sqlite3.connect(path, timeout=5)
    try:
        connection.execute("UPDATE Job SET stop=1, info='Stopping job...' WHERE id=?", (execution_id,))
        connection.commit()
    finally:
        connection.close()


def _backup_loss_db(source: Path, destination: Path) -> None:
    if not source.exists():
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp")
    source_db = None
    target_db = None
    try:
        source_db = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True, timeout=2)
        target_db = sqlite3.connect(temporary)
        source_db.backup(target_db)
        target_db.close()
        target_db = None
        source_db.close()
        source_db = None
        os.replace(temporary, destination)
    finally:
        if target_db is not None:
            target_db.close()
        if source_db is not None:
            source_db.close()
        temporary.unlink(missing_ok=True)


def _resolve_placeholders(config: dict[str, Any], replacements: dict[str, str]) -> dict[str, Any]:
    def walk(value: Any) -> Any:
        if isinstance(value, dict):
            return {key: walk(item) for key, item in value.items()}
        if isinstance(value, list):
            return [walk(item) for item in value]
        if isinstance(value, str):
            result = value
            for token, replacement in replacements.items():
                result = result.replace(token, replacement)
            if "${AITK_" in result:
                raise RemoteWorkerError("CONFIG_INVALID", f"Unresolved remote placeholder in {value}")
            return result
        return value

    return walk(config)


def _model_directory(volume_root: Path, repository: str, revision: str) -> Path:
    safe_repository = re.sub(r"[^A-Za-z0-9._-]+", "--", repository)
    return volume_root / "models" / "huggingface" / safe_repository / revision


def _inventory_model(root: Path) -> list[dict[str, Any]]:
    files = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink() or ".cache" in path.parts or path.name == ".aitk-model-ready.json":
            continue
        digest, size = _hash_file(path)
        files.append({"path": path.relative_to(root).as_posix(), "bytes": size, "sha256": digest})
    return files


def _verify_model_inventory(root: Path, metadata: dict[str, Any]) -> None:
    declared = metadata.get("files")
    if not isinstance(declared, list) or not declared or len(declared) > 100_000:
        raise RemoteWorkerError("MODEL_CACHE_INVALID", "Cached model inventory is missing or exceeds the safety limit")
    expected: dict[str, tuple[int, str]] = {}
    for item in declared:
        if not isinstance(item, dict):
            raise RemoteWorkerError("MODEL_CACHE_INVALID", "Cached model inventory contains an invalid entry")
        relative = str(item.get("path") or "").replace("\\", "/")
        parts = relative.split("/") if relative else []
        digest = str(item.get("sha256") or "")
        size = item.get("bytes")
        if (
            not parts
            or any(part in {"", ".", ".."} for part in parts)
            or relative.startswith("/")
            or not isinstance(size, int)
            or size < 0
            or not re.fullmatch(r"[0-9a-f]{64}", digest)
            or relative in expected
        ):
            raise RemoteWorkerError("MODEL_CACHE_INVALID", "Cached model inventory contains an unsafe entry")
        expected[relative] = (size, digest)
    actual_paths = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and not path.is_symlink() and ".cache" not in path.parts and path.name != ".aitk-model-ready.json"
    }
    if actual_paths != set(expected):
        raise RemoteWorkerError("MODEL_CACHE_INVALID", "Cached model files do not match the completed inventory")
    for relative, (expected_size, expected_digest) in expected.items():
        candidate = root.joinpath(*relative.split("/"))
        if not candidate.is_file() or candidate.is_symlink():
            raise RemoteWorkerError("MODEL_CACHE_INVALID", f"Cached model file is missing: {relative}")
        digest, size = _hash_file(candidate)
        if size != expected_size or digest != expected_digest:
            raise RemoteWorkerError("MODEL_CACHE_INVALID", f"Cached model checksum mismatch: {relative}")


def _materialize_model(volume_root: Path, repository: str, revision: str, progress: ProgressCallback) -> Path:
    final = _model_directory(volume_root, repository, revision)
    ready = final / ".aitk-model-ready.json"
    if ready.exists():
        metadata = json.loads(ready.read_text(encoding="utf-8"))
        if metadata.get("repository") == repository and metadata.get("revision") == revision and metadata.get("files"):
            progress({"phase": "model_cache_verification", "info": "Verifying the pinned model cache"})
            _verify_model_inventory(final, metadata)
            return final
        raise RemoteWorkerError("MODEL_CACHE_INVALID", "Cached model identity or file inventory does not match the bundle")

    final.parent.mkdir(parents=True, exist_ok=True)
    lock = final.with_suffix(".lock")
    deadline = time.monotonic() + int(os.environ.get("AITK_MODEL_LOCK_TIMEOUT_SECONDS", "3600"))
    stale_lock_seconds = int(os.environ.get("AITK_MODEL_LOCK_STALE_SECONDS", "900"))
    owner = False
    while time.monotonic() < deadline:
        try:
            descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            os.write(descriptor, json.dumps({"pid": os.getpid(), "time": time.time()}).encode("utf-8"))
            os.close(descriptor)
            owner = True
            break
        except FileExistsError:
            if ready.exists():
                return final
            try:
                if time.time() - lock.stat().st_mtime > stale_lock_seconds:
                    lock.unlink()
                    continue
            except FileNotFoundError:
                continue
            progress({"phase": "model_cache_wait", "info": "Waiting for the pinned model cache"})
            time.sleep(5)
    if not owner:
        raise RemoteWorkerError("MODEL_CACHE_LOCK_TIMEOUT", "Timed out waiting for the model cache lock")

    partial = final.with_name(f".{final.name}.{os.getpid()}.partial")
    try:
        # A completed cache always has its ready inventory. Anything else at
        # this exact revision path is an interrupted materialization and is
        # safe to replace while holding the revision lock.
        if final.exists():
            if ready.exists():
                metadata = json.loads(ready.read_text(encoding="utf-8"))
                _verify_model_inventory(final, metadata)
                return final
            shutil.rmtree(final)
        shutil.rmtree(partial, ignore_errors=True)
        progress({"phase": "model_download", "info": f"Downloading {repository}@{revision[:12]}"})
        try:
            from huggingface_hub import snapshot_download

            snapshot_download(
                repo_id=repository,
                revision=revision,
                token=os.environ.get("HF_TOKEN") or None,
                local_dir=partial,
            )
        except Exception as exc:
            raise RemoteWorkerError("MODEL_REVISION_UNAVAILABLE", f"Could not download pinned model: {exc}") from exc
        progress({"phase": "model_verification", "info": "Hashing the pinned model snapshot"})
        _atomic_json(
            partial / ".aitk-model-ready.json",
            {"repository": repository, "revision": revision, "files": _inventory_model(partial)},
        )
        if final.exists():
            shutil.rmtree(partial, ignore_errors=True)
        else:
            os.replace(partial, final)
        return final
    finally:
        shutil.rmtree(partial, ignore_errors=True)
        lock.unlink(missing_ok=True)


def _inventory_artifacts(root: Path) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    if not root.exists():
        return artifacts
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink() or path.name.endswith((".partial", ".tmp", "-wal", "-shm")):
            continue
        digest, size = _hash_file(path)
        relative = path.relative_to(root).as_posix()
        role = "output"
        if relative.startswith("samples/"):
            role = "sample"
        elif path.suffix == ".safetensors":
            role = "lora"
        elif "optimizer" in path.name.lower():
            role = "optimizer"
        elif path.name == "loss_log.db":
            role = "metrics"
        elif path.name == "log.txt":
            role = "log"
        artifacts.append({"path": relative, "role": role, "bytes": size, "sha256": digest})
    return artifacts


class WorkerRun:
    def __init__(self, request: dict[str, Any], volume_root: Path, toolkit_root: Path, progress_callback: ProgressCallback):
        self.request = validate_request(request)
        self.volume_root = volume_root.resolve()
        self.toolkit_root = toolkit_root.resolve()
        self.progress_callback = progress_callback
        self.execution_id = self.request["executionId"]
        self.run_dir = self.volume_root / _safe_relative_key(self.request["runPrefix"], "runPrefix")
        self.sequence = 0
        self.last_progress: dict[str, Any] = {}
        self.started_at = time.time()
        self.live_checkpoint_signatures: dict[str, tuple[int, int, str]] = {}
        self.last_live_checkpoint_index = ""

    def publish(self, update: dict[str, Any]) -> None:
        self.sequence += 1
        event = {
            "schemaVersion": 1,
            "sequence": self.sequence,
            "executionId": self.execution_id,
            "timestamp": time.time(),
            "heartbeat": True,
            **self.last_progress,
            **update,
        }
        self.last_progress = {key: value for key, value in event.items() if key not in {"sequence", "timestamp"}}
        _atomic_json(self.run_dir / "state" / "current.json", event)
        _atomic_json(self.run_dir / "state" / "events" / f"{self.sequence:08d}.json", event)
        self.progress_callback(event)

    def _claim(self) -> dict[str, Any] | None:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        result_path = self.run_dir / "result.json"
        if result_path.exists():
            return json.loads(result_path.read_text(encoding="utf-8"))
        claim_path = self.run_dir / "claim.json"
        value = {
            "schemaVersion": 1,
            "executionId": self.execution_id,
            "requestKey": self.request["requestKey"],
            "pid": os.getpid(),
            "claimedAt": time.time(),
        }
        try:
            descriptor = os.open(claim_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(value, handle, sort_keys=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            return None
        except FileExistsError:
            existing = json.loads(claim_path.read_text(encoding="utf-8"))
            if existing.get("requestKey") != self.request["requestKey"]:
                raise RemoteWorkerError("EXECUTION_CONFLICT", "Execution ID was claimed by a different request")
            current_path = self.run_dir / "state" / "current.json"
            heartbeat = 0.0
            try:
                heartbeat = float(json.loads(current_path.read_text(encoding="utf-8")).get("timestamp") or 0)
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                pass
            stale_after = int(os.environ.get("AITK_CLAIM_STALE_SECONDS", "1800"))
            newest_activity = max(float(existing.get("claimedAt") or 0), heartbeat)
            if newest_activity and time.time() - newest_activity > stale_after:
                stale = self.run_dir / f"claim.stale.{int(time.time())}.{os.getpid()}.json"
                try:
                    os.replace(claim_path, stale)
                    return self._claim()
                except FileNotFoundError:
                    return self._claim()
            return {
                "schemaVersion": 1,
                "executionId": self.execution_id,
                "status": "duplicate",
                "runPrefix": self.request["runPrefix"],
                "message": "An identical execution already owns this run prefix",
            }

    def _publish_completed_checkpoints(self, output_dir: Path, current_step: int) -> None:
        entries: list[dict[str, Any]] = []
        present: set[str] = set()
        for candidate in sorted(output_dir.glob("*_*.safetensors")):
            match = re.search(r"_(\d{9})\.safetensors$", candidate.name)
            if not match or candidate.is_symlink() or not candidate.is_file():
                continue
            checkpoint_step = int(match.group(1))
            # DiffusionTrainer updates its step before maybe_save(). Waiting
            # until a later step proves the save hook returned successfully.
            if current_step <= checkpoint_step:
                continue
            relative = candidate.relative_to(output_dir).as_posix()
            present.add(relative)
            before = candidate.stat()
            signature = self.live_checkpoint_signatures.get(relative)
            if signature and signature[:2] == (before.st_size, before.st_mtime_ns):
                digest = signature[2]
            else:
                digest, size = _hash_file(candidate)
                after = candidate.stat()
                if (size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                    continue
                self.live_checkpoint_signatures[relative] = (size, after.st_mtime_ns, digest)
            entries.append(
                {
                    "path": relative,
                    "role": "lora-checkpoint",
                    "step": checkpoint_step,
                    "bytes": before.st_size,
                    "sha256": digest,
                }
            )
        self.live_checkpoint_signatures = {
            key: value for key, value in self.live_checkpoint_signatures.items() if key in present
        }
        value = {"schemaVersion": 1, "executionId": self.execution_id, "artifacts": entries}
        canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        if canonical != self.last_live_checkpoint_index:
            _atomic_json(self.run_dir / "state" / "live-artifacts.json", value)
            self.last_live_checkpoint_index = canonical

    def run(self) -> dict[str, Any]:
        duplicate = self._claim()
        if duplicate is not None:
            return duplicate
        expected_image = os.environ.get("AITK_WORKER_IMAGE_DIGEST", "").strip()
        if not expected_image:
            raise RemoteWorkerError("WORKER_IDENTITY_UNCONFIGURED", "AITK_WORKER_IMAGE_DIGEST is required")
        if expected_image != self.request["expectedWorkerImageDigest"]:
            raise RemoteWorkerError("WORKER_IDENTITY_MISMATCH", "Worker image digest does not match the request")
        bundle_path = self.volume_root / _safe_relative_key(self.request["bundleKey"], "bundleKey")
        if not bundle_path.is_file():
            raise RemoteWorkerError("BUNDLE_MISSING", "Training bundle was not found on the mounted volume")
        archive_hash, _ = _hash_file(bundle_path)
        if archive_hash != self.request["bundleArchiveSha256"]:
            raise RemoteWorkerError("BUNDLE_CHECKSUM_MISMATCH", "Training bundle archive checksum does not match")

        work = self.run_dir / "work"
        extracted = work / "bundle"
        extracted_marker = work / "bundle.extracted.json"
        self.publish({"phase": "bundle_validation", "info": "Verifying and extracting training bundle", "step": 0})
        if extracted.exists() and not extracted_marker.exists():
            shutil.rmtree(extracted)
        if not extracted.exists():
            safe_extract_training_bundle(bundle_path, extracted)
            _atomic_json(
                extracted_marker,
                {
                    "bundleContentDigest": self.request["bundleContentDigest"],
                    "bundleArchiveSha256": self.request["bundleArchiveSha256"],
                },
            )
        else:
            extraction = json.loads(extracted_marker.read_text(encoding="utf-8"))
            if (
                extraction.get("bundleContentDigest") != self.request["bundleContentDigest"]
                or extraction.get("bundleArchiveSha256") != self.request["bundleArchiveSha256"]
            ):
                raise RemoteWorkerError("BUNDLE_CHECKSUM_MISMATCH", "Existing extracted bundle identity does not match")
        manifest = json.loads((extracted / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("contentDigest") != self.request["bundleContentDigest"]:
            raise RemoteWorkerError("BUNDLE_CHECKSUM_MISMATCH", "Bundle content digest does not match the request")
        source_commit = os.environ.get("AITK_SOURCE_COMMIT", "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{40}", source_commit):
            raise RemoteWorkerError("WORKER_IDENTITY_UNCONFIGURED", "AITK_SOURCE_COMMIT is missing from the worker image")
        if source_commit != str((manifest.get("source") or {}).get("gitCommit") or "").lower():
            raise RemoteWorkerError("WORKER_SOURCE_MISMATCH", "Worker source commit does not match the bundle source commit")
        config = yaml.safe_load((extracted / "train.template.yaml").read_text(encoding="utf-8"))
        process_config = config["config"]["process"][0]
        total_steps = int((process_config.get("train") or {}).get("steps") or 0)
        control_db = work / "control.db"
        _initialize_control_db(control_db, self.execution_id, total_steps)

        model = manifest["model"]
        model_dir = _materialize_model(self.volume_root, model["repository"], model["revision"], self.publish)
        model_provenance = json.loads((model_dir / ".aitk-model-ready.json").read_text(encoding="utf-8"))
        output_root = self.run_dir / "output"
        resolved = _resolve_placeholders(
            config,
            {
                "${AITK_DATASET_DIR}": str(extracted / "dataset"),
                "${AITK_OUTPUT_ROOT}": str(output_root),
                "${AITK_CONTROL_DB}": str(control_db),
                "${AITK_MODEL_DIR}": str(model_dir),
                "${AITK_VALIDATION_DIR}": str(extracted / "validation"),
            },
        )
        # The immutable revision is enforced by the materialized local path and
        # manifest. Keep provider-only metadata away from AI Toolkit model
        # constructors that do not accept a revision keyword.
        resolved["config"]["process"][0]["model"].pop("revision", None)
        resolved_path = work / "config.resolved.json"
        _atomic_json(resolved_path, resolved)
        job_name = str(resolved["config"]["name"])
        output_dir = output_root / job_name
        output_dir.mkdir(parents=True, exist_ok=True)
        if self.request.get("resumePrefix"):
            resume_root = self.volume_root / _safe_relative_key(self.request["resumePrefix"], "resumePrefix") / "output"
            resume_output = resume_root / job_name
            if not resume_output.is_dir():
                raise RemoteWorkerError("RESUME_ARTIFACT_MISSING", "The selected resume output does not exist")
            shutil.copytree(resume_output, output_dir, dirs_exist_ok=True)
        shutil.copy2(resolved_path, output_dir / "config.resolved.json")

        log_path = output_dir / "log.txt"
        command = [sys.executable, "-u", str(self.toolkit_root / "run.py"), str(resolved_path)]
        environment = dict(os.environ)
        for secret_name in (
            "RUNPOD_API_KEY",
            "RUNPOD_S3_ACCESS_ID",
            "RUNPOD_S3_SECRET",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "HF_TOKEN",
        ):
            environment.pop(secret_name, None)
        environment.update(
            {
                "PYTHONPATH": str(self.toolkit_root),
                "PYTHONUNBUFFERED": "1",
                "PYTHONIOENCODING": "utf-8",
                "CUDA_DEVICE_ORDER": "PCI_BUS_ID",
                "CUDA_VISIBLE_DEVICES": "0",
                "AITK_JOB_ID": self.execution_id,
                "AITK_JOB_OUTPUT_DIR": str(output_dir),
                "IS_AI_TOOLKIT_UI": "1",
                "SEED": str(manifest["training"]["trainingSeed"]),
                "HF_HUB_ENABLE_HF_TRANSFER": os.environ.get("HF_HUB_ENABLE_HF_TRANSFER", "1"),
                "HF_HUB_DISABLE_XET": os.environ.get("HF_HUB_DISABLE_XET", "0"),
            }
        )
        self.publish({"phase": "starting", "info": "Starting AI Toolkit", "totalSteps": total_steps})
        stop_event = threading.Event()

        with log_path.open("a", encoding="utf-8", newline="") as log_handle:
            child = subprocess.Popen(
                command,
                cwd=self.toolkit_root,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                start_new_session=True,
            )

            def drain_output() -> None:
                assert child.stdout is not None
                for line in child.stdout:
                    log_handle.write(line)
                    log_handle.flush()
                stop_event.set()

            output_thread = threading.Thread(target=drain_output, name="aitk-log-drain", daemon=True)
            output_thread.start()
            last_loss_backup = 0.0
            stop_acknowledged = False
            invalid_control_seen = False
            while child.poll() is None:
                control = _read_control_db(control_db, self.execution_id)
                stop_request = self.run_dir / "control" / "stop.json"
                if stop_request.exists() and not stop_acknowledged and not invalid_control_seen:
                    try:
                        stop_payload = json.loads(stop_request.read_text(encoding="utf-8"))
                    except (OSError, UnicodeError, json.JSONDecodeError):
                        stop_payload = None
                    if not isinstance(stop_payload, dict) or stop_payload.get("schemaVersion") != 1 or stop_payload.get("executionId") != self.execution_id:
                        invalid_control_seen = True
                        self.publish({"controlWarning": "Rejected invalid stop request"})
                    else:
                        _set_stop(control_db, self.execution_id)
                        stop_acknowledged = True
                        _atomic_json(
                            self.run_dir / "control" / "stop-ack.json",
                            {"executionId": self.execution_id, "acknowledgedAt": time.time()},
                        )
                self.publish(
                    {
                        "phase": "training",
                        "info": control.get("info") or "Training",
                        "step": int(control.get("step") or 0),
                        "totalSteps": int(control.get("total_steps") or total_steps),
                        "speed": control.get("speed_string") or "",
                        "stopRequested": stop_acknowledged,
                    }
                )
                self._publish_completed_checkpoints(output_dir, int(control.get("step") or 0))
                now = time.monotonic()
                if now - last_loss_backup >= 10:
                    _backup_loss_db(output_dir / "loss_log.db", self.run_dir / "state" / "loss_log.db")
                    last_loss_backup = now
                time.sleep(2)
            output_thread.join(timeout=10)
            return_code = child.wait()

        _backup_loss_db(output_dir / "loss_log.db", self.run_dir / "state" / "loss_log.db")
        control = _read_control_db(control_db, self.execution_id)
        stopped = bool(control.get("stop")) or control.get("status") == "stopped"
        if return_code != 0 and not stopped:
            raise RemoteWorkerError("TRAINING_FAILED", f"AI Toolkit exited with code {return_code}")

        self.publish({"phase": "finalizing", "info": "Hashing final artifacts", "step": int(control.get("step") or 0)})
        package_versions = {}
        for distribution in ("torch", "torchao", "diffusers", "transformers", "accelerate", "bitsandbytes", "lycoris-lora"):
            try:
                package_versions[distribution] = importlib.metadata.version(distribution)
            except importlib.metadata.PackageNotFoundError:
                package_versions[distribution] = None
        _atomic_json(
            output_dir / "run-manifest.json",
            {
                "schemaVersion": 1,
                "executionId": self.execution_id,
                "requestKey": self.request["requestKey"],
                "bundleContentDigest": self.request["bundleContentDigest"],
                "bundleArchiveSha256": self.request["bundleArchiveSha256"],
                "workerImageDigest": self.request["expectedWorkerImageDigest"],
                "sourceCommit": source_commit,
                "dependencyLockSha256": os.environ.get("AITK_DEPENDENCY_LOCK_SHA256"),
                "model": manifest.get("model"),
                "modelCache": model_provenance,
                "requestedGpu": "NVIDIA H100",
                "actualGpu": os.environ.get("RUNPOD_GPU_NAME") or os.environ.get("NVIDIA_GPU_NAME") or "unknown",
                "python": platform.python_version(),
                "platform": platform.platform(),
                "packages": package_versions,
                "cuda": os.environ.get("CUDA_VERSION"),
                "startedAt": self.started_at,
                "finishedAt": time.time(),
                "returnCode": return_code,
                "status": "stopped" if stopped else "completed",
                "finalStep": int(control.get("step") or 0),
                "resumePrefix": self.request.get("resumePrefix"),
            },
        )
        artifacts = _inventory_artifacts(output_dir)
        artifact_index = {"schemaVersion": 1, "executionId": self.execution_id, "artifacts": artifacts}
        artifact_index_path = self.run_dir / "artifacts.json"
        _atomic_json(artifact_index_path, artifact_index)
        index_hash, _ = _hash_file(artifact_index_path)
        status = "stopped" if stopped else "completed"
        safe_message = _redact_message(exc)
        result = {
            "schemaVersion": 1,
            "executionId": self.execution_id,
            "status": status,
            "runPrefix": self.request["runPrefix"],
            "finalStep": int(control.get("step") or 0),
            "artifactIndexSha256": index_hash,
            "actualGpu": os.environ.get("RUNPOD_GPU_NAME") or os.environ.get("NVIDIA_GPU_NAME") or "unknown",
            "finishedAt": time.time(),
        }
        _atomic_json(self.run_dir / "result.json", result)
        marker = self.run_dir / ("STOPPED" if stopped else "COMPLETE")
        # The terminal marker is deliberately last. A result without the
        # matching marker is partial and must never be imported as complete.
        _atomic_text(marker, index_hash + "\n")
        self.publish({"phase": status, "info": f"Remote training {status}", "step": result["finalStep"]})
        return result


def run_remote_training(
    request: dict[str, Any],
    *,
    progress_callback: ProgressCallback | None = None,
    volume_root: str | Path | None = None,
    toolkit_root: str | Path | None = None,
) -> dict[str, Any]:
    progress_callback = progress_callback or (lambda _event: None)
    volume = Path(volume_root or os.environ.get("AITK_RUNPOD_VOLUME_ROOT", "/runpod-volume/aitk"))
    toolkit = Path(toolkit_root or os.environ.get("AITK_TOOLKIT_ROOT", Path(__file__).resolve().parents[2]))
    runner = WorkerRun(request, volume, toolkit, progress_callback)
    try:
        return runner.run()
    except Exception as exc:
        code = exc.code if isinstance(exc, RemoteWorkerError) else "WORKER_UNEXPECTED"
        safe_message = _redact_message(exc)
        result = {
            "schemaVersion": 1,
            "executionId": runner.execution_id,
            "status": "failed",
            "runPrefix": request.get("runPrefix"),
            "error": {"code": code, "message": safe_message, "tracebackSha256": hashlib.sha256(traceback.format_exc().encode()).hexdigest()},
            "finishedAt": time.time(),
        }
        try:
            _atomic_json(runner.run_dir / "result.json", result)
            runner.publish({"phase": "failed", "info": f"{code}: {safe_message[:500]}"})
        except Exception:
            pass
        raise
