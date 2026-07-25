from __future__ import annotations

import copy
import datetime as dt
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import stat
import tarfile
import tempfile
import unicodedata
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Iterable

import yaml
from PIL import Image, UnidentifiedImageError


SCHEMA_VERSION = 1
SUPPORTED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
KNOWN_UNSUPPORTED_IMAGE_EXTENSIONS = {
    ".avif",
    ".arw",
    ".bmp",
    ".cr2",
    ".dng",
    ".exr",
    ".gif",
    ".hdr",
    ".heic",
    ".heif",
    ".ico",
    ".jfif",
    ".jxl",
    ".nef",
    ".raw",
    ".svg",
    ".tif",
    ".tiff",
}
IGNORED_DIRECTORIES = {"_latent_cache", "_t_e_cache", "_controls", "__pycache__"}
IGNORED_FILES = {".aitk_size.json", ".aitk_caption_provenance.partial.json"}
MAX_FILE_COUNT = 100_000
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024 * 1024
MAX_IMAGE_PIXELS = 120_000_000
MAX_CAPTION_BYTES = 1024 * 1024
CHUNK_SIZE = 1024 * 1024

REFUSAL_PATTERNS = [
    re.compile(r"^\s*(?:i(?:'m| am) sorry[,.:]?\s+but\s+)?i (?:can(?:not|'t)|won't)\b", re.I),
    re.compile(r"^\s*(?:unable|failed) to (?:caption|process|analy[sz]e|describe)\b", re.I),
    re.compile(r"^\s*(?:gemini|google genai|provider) (?:api )?(?:error|failure)\b", re.I),
    re.compile(r"^\s*\{\s*\"(?:error|message)\"\s*:\s*", re.I),
    re.compile(r"^\s*(?:error|exception|quota exceeded|resource exhausted|permission denied)\s*[:\-]", re.I),
]


class BundleError(RuntimeError):
    pass


class BundleValidationError(BundleError):
    def __init__(self, report: dict[str, Any]):
        super().__init__("Training bundle validation failed")
        self.report = report


@dataclass(frozen=True)
class SourceFile:
    source: Path
    bundle_path: str
    sha256: str
    size: int
    media_type: str
    original_relative_path: str
    dataset_index: int | None = None


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(CHUNK_SIZE)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
    return digest.hexdigest(), size


def _is_within(candidate: Path, root: Path) -> bool:
    try:
        candidate.relative_to(root)
        return candidate != root
    except ValueError:
        return False


def _normalized_collision_key(value: str) -> str:
    return unicodedata.normalize("NFC", value).casefold()


def _safe_display_path(path: Path, root: Path) -> str:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.name


def _add_problem(report: dict[str, Any], severity: str, code: str, message: str, path: str | None = None) -> None:
    item: dict[str, Any] = {"code": code, "message": message}
    if path:
        item["path"] = path
    report[severity].append(item)


def _read_caption(path: Path) -> str:
    raw = path.read_bytes()
    if len(raw) > MAX_CAPTION_BYTES:
        raise ValueError(f"caption exceeds {MAX_CAPTION_BYTES} bytes")
    caption = raw.decode("utf-8-sig")
    if "\x00" in caption:
        raise ValueError("caption contains NUL characters")
    return caption.strip()


def _looks_like_refusal(caption: str) -> bool:
    return any(pattern.search(caption) for pattern in REFUSAL_PATTERNS)


def _verify_regular_file(path: Path, root: Path) -> os.stat_result:
    before = path.lstat()
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise ValueError("file is not a regular non-symlink file")
    resolved = path.resolve(strict=True)
    if not _is_within(resolved, root):
        raise ValueError("file resolves outside the configured dataset")
    return before


def _verify_unchanged(path: Path, before: os.stat_result, digest_size: int) -> None:
    after = path.lstat()
    if (
        after.st_size != before.st_size
        or after.st_mtime_ns != before.st_mtime_ns
        or getattr(after, "st_ino", None) != getattr(before, "st_ino", None)
        or digest_size != after.st_size
    ):
        raise ValueError("file changed while the bundle was being prepared")


def _image_media_type(extension: str) -> str:
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }[extension]


def _verify_image(path: Path, extension: str) -> None:
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        with Image.open(path) as image:
            image.verify()
            detected = (image.format or "").lower()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError(f"unsupported or corrupt image: {exc}") from exc
    expected = {".jpg": "jpeg", ".jpeg": "jpeg", ".png": "png", ".webp": "webp"}[extension]
    if detected != expected:
        raise ValueError(f"image bytes are {detected or 'unknown'}, not {expected}")


def _walk_dataset(root: Path) -> Iterable[Path]:
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        directories[:] = sorted(
            directory
            for directory in directories
            if directory not in IGNORED_DIRECTORIES and not directory.startswith(".")
        )
        for name in sorted(files):
            if name in IGNORED_FILES or name.startswith("."):
                continue
            yield current_path / name


def _resolve_model_revision(repository: str, requested_revision: str | None) -> str:
    if Path(repository).exists() or PureWindowsPath(repository).drive:
        raise BundleError("Remote training requires a Hugging Face repository, not a local model path")
    try:
        from huggingface_hub import HfApi

        info = HfApi(token=os.environ.get("HF_TOKEN") or None).model_info(
            repository,
            revision=requested_revision or "main",
        )
    except Exception as exc:
        raise BundleError(f"Could not resolve immutable model revision for {repository}: {exc}") from exc
    if not info.sha or not re.fullmatch(r"[0-9a-fA-F]{40,64}", info.sha):
        raise BundleError(f"Hugging Face did not return an immutable commit for {repository}")
    return info.sha.lower()


def _validate_source_identity(request: dict[str, Any], report: dict[str, Any]) -> None:
    source = request.get("source") or {}
    commit = str(source.get("gitCommit") or "").strip()
    if not re.fullmatch(r"[0-9a-fA-F]{40}", commit):
        _add_problem(report, "errors", "SOURCE_COMMIT_INVALID", "A full 40-character Git commit is required")
    if bool(source.get("dirty")):
        _add_problem(
            report,
            "errors",
            "SOURCE_TREE_DIRTY",
            "Remote submission is blocked until the AI Toolkit code changes are committed",
        )
    image = str(request.get("workerImageDigest") or "").strip()
    if not re.search(r"@sha256:[0-9a-fA-F]{64}$", image):
        _add_problem(
            report,
            "errors",
            "WORKER_IMAGE_MUTABLE",
            "workerImageDigest must be an OCI image reference ending in @sha256:<64 hex characters>",
        )


def _validate_portable_features(process: dict[str, Any], report: dict[str, Any]) -> None:
    for dataset_index, dataset in enumerate(process.get("datasets") or []):
        for field in ("mask_path", "control_path", "control_path_1", "control_path_2", "control_path_3"):
            if dataset.get(field):
                _add_problem(
                    report,
                    "errors",
                    "DATASET_FEATURE_UNSUPPORTED",
                    f"Remote bundle schema v1 does not yet support datasets[{dataset_index}].{field}",
                )
        if dataset.get("controls"):
            _add_problem(
                report,
                "errors",
                "DATASET_FEATURE_UNSUPPORTED",
                f"Remote bundle schema v1 does not yet support datasets[{dataset_index}].controls",
            )


def _captioning_metadata(request: dict[str, Any], report: dict[str, Any]) -> dict[str, Any]:
    supplied = copy.deepcopy(request.get("captioning") or {})
    prompt = str(supplied.pop("prompt", "") or "").strip()
    provider = str(supplied.get("provider") or "manual").strip()
    model = str(supplied.get("model") or "none").strip()
    if not prompt:
        prompt = "Manual captions; no automatic-caption prompt provenance was available."
        _add_problem(
            report,
            "warnings",
            "CAPTION_PROVENANCE_MANUAL",
            "No completed automatic-caption provenance was found; the bundle records these captions as manual",
        )
    return {
        "provider": provider,
        "backend": str(supplied.get("backend") or "").strip() or None,
        "model": model,
        "promptTemplateId": str(supplied.get("promptTemplateId") or "").strip() or None,
        "prompt": prompt,
        "promptSha256": _sha256_bytes(prompt.encode("utf-8")),
        "completedAt": supplied.get("completedAt"),
        "sourceJobId": supplied.get("sourceJobId"),
        "failureCount": int(supplied.get("failureCount") or 0),
    }


def _load_caption_provenance(root: Path, report: dict[str, Any]) -> dict[str, Any] | None:
    path = root / ".aitk_caption_provenance.json"
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        _add_problem(report, "errors", "CAPTION_PROVENANCE_INVALID", str(exc), path.name)
        return None
    if value.get("schemaVersion") != 1 or not value.get("complete"):
        _add_problem(report, "errors", "CAPTION_PROVENANCE_INCOMPLETE", "Caption provenance is not complete", path.name)
        return None
    return value


def validate_training_bundle_request(request: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    report: dict[str, Any] = {"errors": [], "warnings": [], "summary": {}}
    config = copy.deepcopy(request.get("jobConfig"))
    if not isinstance(config, dict):
        _add_problem(report, "errors", "CONFIG_INVALID", "jobConfig must be an object")
        return report, {}
    try:
        process = config["config"]["process"][0]
    except (KeyError, IndexError, TypeError):
        _add_problem(report, "errors", "CONFIG_INVALID", "jobConfig.config.process[0] is required")
        return report, {}

    request_name = str(request.get("name") or "").strip()
    config_name = str((config.get("config") or {}).get("name") or "").strip()
    if not request_name or config_name != request_name:
        _add_problem(
            report,
            "errors",
            "TRAINING_NAME_MISMATCH",
            "The saved Job name must exactly match jobConfig.config.name for portable output paths",
        )

    if process.get("type") != "diffusion_trainer":
        _add_problem(report, "errors", "JOB_TYPE_UNSUPPORTED", "Only diffusion_trainer jobs can run remotely")
    datasets = process.get("datasets") or []
    if not datasets:
        _add_problem(report, "errors", "DATASET_MISSING", "At least one dataset is required")
    training_seed = process.get("training_seed")
    if not isinstance(training_seed, int) or isinstance(training_seed, bool):
        _add_problem(
            report,
            "errors",
            "TRAINING_SEED_REQUIRED",
            "Set process.training_seed to an integer before remote export",
        )
    _validate_source_identity(request, report)
    _validate_portable_features(process, report)
    trigger = str(process.get("trigger_word") or "").strip()
    if not trigger:
        _add_problem(report, "errors", "TRIGGER_REQUIRED", "Remote LoRA export requires a non-empty trigger word")
    source_files: list[SourceFile] = []
    blocks: list[dict[str, Any]] = []
    collision_keys: dict[str, str] = {}
    image_hashes: dict[str, str] = {}
    trigger_coverage = {"resolved": 0, "missing": 0, "duplicated": 0}
    pair_index = 0
    dataset_provenance: list[dict[str, Any]] = []

    for dataset_index, dataset in enumerate(datasets):
        raw_root = str(dataset.get("folder_path") or "").strip()
        root = Path(raw_root).expanduser()
        display_root = raw_root or f"dataset {dataset_index + 1}"
        logical_root = "dataset" if len(datasets) == 1 else f"dataset-{dataset_index + 1:02d}"
        if not raw_root or not root.is_dir():
            _add_problem(report, "errors", "DATASET_PATH_INVALID", "Dataset folder does not exist", display_root)
            continue
        try:
            real_root = root.resolve(strict=True)
        except OSError as exc:
            _add_problem(report, "errors", "DATASET_PATH_INVALID", str(exc), display_root)
            continue
        provenance = _load_caption_provenance(real_root, report)
        if provenance:
            dataset_provenance.append(provenance)
        caption_extension = str(dataset.get("caption_ext") or "txt").lstrip(".").lower()
        if not re.fullmatch(r"[a-z0-9_-]+", caption_extension):
            _add_problem(report, "errors", "CAPTION_EXTENSION_INVALID", "Unsafe caption extension", display_root)
            continue

        image_by_stem: dict[str, Path] = {}
        for candidate in _walk_dataset(real_root):
            relative = _safe_display_path(candidate, real_root)
            extension = candidate.suffix.lower()
            if extension in KNOWN_UNSUPPORTED_IMAGE_EXTENSIONS:
                _add_problem(report, "errors", "IMAGE_FORMAT_UNSUPPORTED", f"Unsupported image format {extension}", relative)
                continue
            if extension not in SUPPORTED_IMAGE_EXTENSIONS:
                continue
            stem_key = _normalized_collision_key(str(PurePosixPath(relative).with_suffix("")))
            if stem_key in image_by_stem:
                _add_problem(
                    report,
                    "errors",
                    "DUPLICATE_IMAGE_STEM",
                    f"Ambiguous image stem also used by {_safe_display_path(image_by_stem[stem_key], real_root)}",
                    relative,
                )
                continue
            image_by_stem[stem_key] = candidate

        block_count = 0
        for image_path in sorted(image_by_stem.values(), key=lambda item: _normalized_collision_key(_safe_display_path(item, real_root))):
            relative = _safe_display_path(image_path, real_root)
            collision_key = _normalized_collision_key(relative)
            if collision_key in collision_keys:
                _add_problem(
                    report,
                    "errors",
                    "DUPLICATE_FILENAME",
                    f"Portable filename collision with {collision_keys[collision_key]}",
                    relative,
                )
                continue
            collision_keys[collision_key] = relative
            caption_path = image_path.with_suffix(f".{caption_extension}")
            caption_relative = _safe_display_path(caption_path, real_root)
            try:
                image_stat = _verify_regular_file(image_path, real_root)
                _verify_image(image_path, image_path.suffix.lower())
                image_sha, image_size = _sha256_file(image_path)
                _verify_unchanged(image_path, image_stat, image_size)
            except (OSError, ValueError) as exc:
                _add_problem(report, "errors", "IMAGE_INVALID", str(exc), relative)
                continue
            if image_sha in image_hashes:
                _add_problem(
                    report,
                    "warnings",
                    "DUPLICATE_IMAGE_BYTES",
                    f"Image bytes duplicate {image_hashes[image_sha]}",
                    relative,
                )
            else:
                image_hashes[image_sha] = relative
            try:
                caption_stat = _verify_regular_file(caption_path, real_root)
                caption = _read_caption(caption_path)
                caption_sha, caption_size = _sha256_file(caption_path)
                _verify_unchanged(caption_path, caption_stat, caption_size)
            except (OSError, UnicodeError, ValueError) as exc:
                code = "CAPTION_MISSING" if isinstance(exc, FileNotFoundError) else "CAPTION_INVALID"
                _add_problem(report, "errors", code, str(exc), caption_relative)
                continue
            if provenance:
                expected_caption_hash = (provenance.get("captions") or {}).get(relative)
                if expected_caption_hash != caption_sha:
                    _add_problem(
                        report,
                        "errors",
                        "CAPTION_PROVENANCE_STALE",
                        "Caption bytes no longer match the completed caption job provenance",
                        caption_relative,
                    )
                    continue
            if not caption:
                _add_problem(report, "errors", "CAPTION_EMPTY", "Caption is empty", caption_relative)
                continue
            if _looks_like_refusal(caption):
                _add_problem(
                    report,
                    "errors",
                    "CAPTION_PROVIDER_ERROR",
                    "Caption looks like a provider refusal or error response",
                    caption_relative,
                )
                continue

            if trigger:
                placeholder_count = caption.count("[trigger]")
                literal_count = caption.casefold().count(trigger.casefold())
                resolved_count = placeholder_count + literal_count
                if resolved_count == 0:
                    trigger_coverage["missing"] += 1
                    _add_problem(report, "errors", "TRIGGER_MISSING", "Caption does not contain [trigger] or the literal trigger", caption_relative)
                else:
                    trigger_coverage["resolved"] += 1
                if resolved_count > 1:
                    trigger_coverage["duplicated"] += 1
                    _add_problem(report, "errors", "TRIGGER_DUPLICATED", "Caption would contain the trigger more than once", caption_relative)

            pair_index += 1
            block_count += 1
            if len(datasets) == 1:
                bundle_root = "dataset"
            else:
                bundle_root = f"dataset/dataset-{dataset_index + 1:02d}"
            bundle_stem = f"{pair_index:04d}"
            image_bundle_path = f"{bundle_root}/{bundle_stem}{image_path.suffix.lower()}"
            caption_bundle_path = f"{bundle_root}/{bundle_stem}.txt"
            source_files.extend(
                [
                    SourceFile(
                        image_path,
                        image_bundle_path,
                        image_sha,
                        image_size,
                        _image_media_type(image_path.suffix.lower()),
                        relative,
                        dataset_index,
                    ),
                    SourceFile(
                        caption_path,
                        caption_bundle_path,
                        caption_sha,
                        caption_size,
                        "text/plain; charset=utf-8",
                        caption_relative,
                        dataset_index,
                    ),
                ]
            )
        blocks.append({"index": dataset_index, "imageCount": block_count, "logicalRoot": logical_root})

    if pair_index == 0:
        _add_problem(report, "errors", "DATASET_EMPTY", "No valid image/caption pairs were found")
    if len(source_files) > MAX_FILE_COUNT:
        _add_problem(report, "errors", "BUNDLE_FILE_LIMIT", f"Bundle exceeds {MAX_FILE_COUNT} files")

    captioning_request = request
    if not request.get("captioning") and dataset_provenance:
        provenance_identities = {
            _sha256_bytes(
                _canonical_json(
                    {
                        key: provenance.get(key)
                        for key in ("provider", "backend", "model", "promptTemplateId", "prompt")
                    }
                )
            )
            for provenance in dataset_provenance
        }
        if len(provenance_identities) > 1:
            _add_problem(
                report,
                "errors",
                "CAPTION_PROVENANCE_MISMATCH",
                "Datasets were captioned with different providers, models, prompts, or templates",
            )
        provenance = dataset_provenance[0]
        captioning_request = {
            **request,
            "captioning": {
                "provider": provenance.get("provider"),
                "backend": provenance.get("backend"),
                "model": provenance.get("model"),
                "promptTemplateId": provenance.get("promptTemplateId"),
                "prompt": provenance.get("prompt"),
                "completedAt": provenance.get("completedAt"),
                "sourceJobId": provenance.get("captionJobId"),
                "failureCount": provenance.get("failureCount", 0),
            },
        }
    captioning = _captioning_metadata(captioning_request, report)
    if captioning["failureCount"]:
        _add_problem(
            report,
            "errors",
            "CAPTION_JOB_INCOMPLETE",
            f"Caption provenance reports {captioning['failureCount']} failed image(s)",
        )

    report["summary"] = {
        "imageCount": pair_index,
        "captionCount": pair_index,
        "datasetCount": len(datasets),
        "triggerCoverage": trigger_coverage,
        "errorCount": len(report["errors"]),
        "warningCount": len(report["warnings"]),
    }
    context = {
        "config": config,
        "process": process,
        "sourceFiles": source_files,
        "blocks": blocks,
        "captioning": captioning,
        "triggerCoverage": trigger_coverage,
    }
    return report, context


def _portable_config(config: dict[str, Any], model_revision: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    portable = copy.deepcopy(config)
    process = portable["config"]["process"][0]
    transformations: list[dict[str, Any]] = []

    def replace(path_label: str, container: dict[str, Any], key: str, value: Any) -> None:
        container[key] = value
        # Do not leak absolute workstation paths into a portable manifest.
        transformations.append({"path": path_label, "to": value})

    replace("/config/process/0/training_folder", process, "training_folder", "${AITK_OUTPUT_ROOT}")
    replace("/config/process/0/sqlite_db_path", process, "sqlite_db_path", "${AITK_CONTROL_DB}")
    for index, dataset in enumerate(process.get("datasets") or []):
        if len(process.get("datasets") or []) == 1:
            value = "${AITK_DATASET_DIR}"
        else:
            value = f"${{AITK_DATASET_DIR}}/dataset-{index + 1:02d}"
        replace(f"/config/process/0/datasets/{index}/folder_path", dataset, "folder_path", value)
    model = process.get("model") or {}
    replace("/config/process/0/model/name_or_path", model, "name_or_path", "${AITK_MODEL_DIR}")
    model["revision"] = model_revision
    return portable, transformations


def _resume_compatibility_sha256(portable_config: dict[str, Any]) -> str:
    compatible = copy.deepcopy(portable_config)
    process = compatible["config"]["process"][0]
    train = process.get("train") or {}
    train.pop("steps", None)
    save = process.get("save") or {}
    for key in ("save_every", "max_step_saves_to_keep"):
        save.pop(key, None)
    sample = process.get("sample") or {}
    for key in ("sample_every", "sample_start_step"):
        sample.pop(key, None)
    return _sha256_bytes(_canonical_json(compatible))


def _tar_info(name: str, size: int, mtime: int, mode: int = 0o644) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name=name)
    info.size = size
    info.mode = mode
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = mtime
    info.type = tarfile.REGTYPE
    return info


def _parse_epoch(value: Any) -> int:
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, str) and value:
        try:
            parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
            return max(0, int(parsed.timestamp()))
        except ValueError:
            pass
    return 0


def export_training_bundle(request: dict[str, Any]) -> dict[str, Any]:
    report, context = validate_training_bundle_request(request)
    if report["errors"]:
        raise BundleValidationError(report)

    process = context["process"]
    repository = str((process.get("model") or {}).get("name_or_path") or "").strip()
    requested_revision = str((process.get("model") or {}).get("revision") or "").strip() or None
    resolved_revision = str(request.get("modelRevision") or "").strip()
    if not resolved_revision:
        resolved_revision = _resolve_model_revision(repository, requested_revision)
    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", resolved_revision):
        raise BundleError("modelRevision must be an immutable hexadecimal commit")
    resolved_revision = resolved_revision.lower()

    portable_config, transformations = _portable_config(context["config"], resolved_revision)
    config_bytes = yaml.safe_dump(portable_config, sort_keys=True, allow_unicode=True).encode("utf-8")
    config_sha = _sha256_bytes(config_bytes)
    epoch = _parse_epoch(request.get("exportEpoch"))
    created_at = dt.datetime.fromtimestamp(epoch, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")

    manifest_files = [
        {
            "path": item.bundle_path,
            "bytes": item.size,
            "sha256": item.sha256,
            "mediaType": item.media_type,
            "originalRelativePath": item.original_relative_path,
            "datasetIndex": item.dataset_index,
        }
        for item in sorted(context["sourceFiles"], key=lambda value: value.bundle_path)
    ]
    semantic = {
        "schemaVersion": SCHEMA_VERSION,
        "bundleType": "aitk-training-bundle",
        "training": {
            "name": str(context["config"]["config"].get("name") or request.get("name") or "training"),
            "architecture": str((process.get("model") or {}).get("arch") or ""),
            "triggerWord": process.get("trigger_word"),
            "trainingSeed": process.get("training_seed"),
            "configSha256": config_sha,
            "resumeCompatibilitySha256": _resume_compatibility_sha256(portable_config),
            "transformations": transformations,
        },
        "model": {
            "repository": repository,
            "requestedRevision": requested_revision,
            "revision": resolved_revision,
        },
        "captioning": context["captioning"],
        "dataset": {
            "imageCount": report["summary"]["imageCount"],
            "captionCount": report["summary"]["captionCount"],
            "blocks": context["blocks"],
            "triggerCoverage": context["triggerCoverage"],
            "files": manifest_files,
        },
        "source": copy.deepcopy(request.get("source") or {}),
        "runtime": {
            "workerImageDigest": request["workerImageDigest"],
            "requiredSecrets": ["HF_TOKEN"],
        },
    }
    content_digest = _sha256_bytes(_canonical_json(semantic))
    manifest = {
        **semantic,
        "contentDigest": f"sha256:{content_digest}",
        "createdAt": created_at,
        "exporter": {"version": "1", "gitCommit": (request.get("source") or {}).get("gitCommit")},
    }
    manifest_bytes = json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2).encode("utf-8") + b"\n"

    output_directory = Path(str(request.get("outputDirectory") or "bundles")).expanduser().resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", str(request.get("bundleName") or "krea2-v1")).strip("-") or "training"
    final_path = output_directory / f"{safe_name}-{content_digest[:16]}.tar.gz"
    partial_path = final_path.with_suffix(final_path.suffix + ".partial")
    partial_path.unlink(missing_ok=True)

    try:
        with partial_path.open("wb") as raw_output:
            with gzip.GzipFile(fileobj=raw_output, mode="wb", filename="", mtime=0, compresslevel=9) as gz_output:
                with tarfile.open(fileobj=gz_output, mode="w", format=tarfile.PAX_FORMAT) as archive:
                    for item in sorted(context["sourceFiles"], key=lambda value: value.bundle_path):
                        before = item.source.lstat()
                        with item.source.open("rb") as source_handle:
                            archive.addfile(_tar_info(item.bundle_path, item.size, epoch), source_handle)
                        _verify_unchanged(item.source, before, item.size)
                    archive.addfile(_tar_info("train.template.yaml", len(config_bytes), epoch), io.BytesIO(config_bytes))
                    archive.addfile(_tar_info("manifest.json", len(manifest_bytes), epoch), io.BytesIO(manifest_bytes))
            raw_output.flush()
            os.fsync(raw_output.fileno())
        archive_sha, archive_size = _sha256_file(partial_path)
        if archive_size > MAX_ARCHIVE_BYTES:
            raise BundleError(f"Bundle exceeds {MAX_ARCHIVE_BYTES} bytes")
        inspection = inspect_training_bundle(partial_path)
        if inspection["manifest"]["contentDigest"] != manifest["contentDigest"]:
            raise BundleError("Bundle verification returned a different content digest")
        os.replace(partial_path, final_path)
    except Exception:
        partial_path.unlink(missing_ok=True)
        raise

    return {
        "ok": True,
        "bundlePath": str(final_path),
        "bundleName": final_path.name,
        "contentDigest": manifest["contentDigest"],
        "archiveSha256": archive_sha,
        "archiveBytes": archive_size,
        "manifest": manifest,
        "validation": report,
    }


def _validate_member_name(name: str) -> str:
    if not name or "\x00" in name:
        raise BundleError("Archive contains an empty or NUL path")
    normalized = unicodedata.normalize("NFC", name.replace("\\", "/"))
    path = PurePosixPath(normalized)
    windows = PureWindowsPath(normalized)
    if path.is_absolute() or windows.is_absolute() or windows.drive or any(part in {"", ".", ".."} for part in path.parts):
        raise BundleError(f"Unsafe archive path: {name}")
    if any(":" in part or part.rstrip(". ") != part for part in path.parts):
        raise BundleError(f"Non-portable archive path: {name}")
    return str(path)


def inspect_training_bundle(path: str | Path) -> dict[str, Any]:
    bundle_path = Path(path)
    archive_sha, archive_size = _sha256_file(bundle_path)
    if archive_size > MAX_ARCHIVE_BYTES:
        raise BundleError("Archive exceeds the configured size limit")
    names: set[str] = set()
    total_size = 0
    manifest: dict[str, Any] | None = None
    file_hashes: dict[str, tuple[str, int]] = {}
    with tarfile.open(bundle_path, mode="r:gz") as archive:
        members = archive.getmembers()
        if len(members) > MAX_FILE_COUNT + 2:
            raise BundleError("Archive contains too many members")
        for member in members:
            name = _validate_member_name(member.name)
            collision = _normalized_collision_key(name)
            if collision in names:
                raise BundleError(f"Archive contains a duplicate member: {name}")
            names.add(collision)
            if not member.isfile() or member.issym() or member.islnk() or member.isdev():
                raise BundleError(f"Archive member is not a regular file: {name}")
            total_size += member.size
            if total_size > MAX_ARCHIVE_BYTES:
                raise BundleError("Archive expands beyond the configured size limit")
            handle = archive.extractfile(member)
            if handle is None:
                raise BundleError(f"Could not read archive member: {name}")
            digest = hashlib.sha256()
            size = 0
            data_for_manifest = bytearray() if name == "manifest.json" else None
            while True:
                chunk = handle.read(CHUNK_SIZE)
                if not chunk:
                    break
                size += len(chunk)
                digest.update(chunk)
                if data_for_manifest is not None:
                    data_for_manifest.extend(chunk)
            if size != member.size:
                raise BundleError(f"Archive member was truncated: {name}")
            file_hashes[name] = (digest.hexdigest(), size)
            if data_for_manifest is not None:
                try:
                    manifest = json.loads(bytes(data_for_manifest).decode("utf-8"))
                except (UnicodeError, json.JSONDecodeError) as exc:
                    raise BundleError(f"Invalid manifest.json: {exc}") from exc
    if not manifest or manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise BundleError("Bundle manifest is missing or uses an unsupported schema")
    if "train.template.yaml" not in file_hashes:
        raise BundleError("Bundle is missing train.template.yaml")
    declared = {entry["path"]: entry for entry in (manifest.get("dataset") or {}).get("files") or []}
    allowed = set(declared) | {"manifest.json", "train.template.yaml"}
    if set(file_hashes) != allowed:
        extras = sorted(set(file_hashes) - allowed)
        missing = sorted(allowed - set(file_hashes))
        raise BundleError(f"Archive member manifest mismatch; extra={extras}, missing={missing}")
    for name, entry in declared.items():
        actual_hash, actual_size = file_hashes[name]
        if actual_hash != entry.get("sha256") or actual_size != entry.get("bytes"):
            raise BundleError(f"Archive member checksum mismatch: {name}")
    return {
        "ok": True,
        "archiveSha256": archive_sha,
        "archiveBytes": archive_size,
        "manifest": manifest,
    }


def safe_extract_training_bundle(path: str | Path, destination: str | Path) -> dict[str, Any]:
    inspection = inspect_training_bundle(path)
    destination_path = Path(destination).resolve()
    destination_path.parent.mkdir(parents=True, exist_ok=True)
    if destination_path.exists():
        raise BundleError(f"Destination already exists: {destination_path}")
    temporary = Path(tempfile.mkdtemp(prefix=f".{destination_path.name}.", dir=str(destination_path.parent)))
    try:
        with tarfile.open(path, mode="r:gz") as archive:
            for member in archive.getmembers():
                name = _validate_member_name(member.name)
                target = (temporary / Path(*PurePosixPath(name).parts)).resolve()
                if not _is_within(target, temporary.resolve()):
                    raise BundleError(f"Archive path escaped destination: {name}")
                target.parent.mkdir(parents=True, exist_ok=True)
                source = archive.extractfile(member)
                if source is None:
                    raise BundleError(f"Could not read archive member: {name}")
                with target.open("xb") as output:
                    shutil.copyfileobj(source, output, CHUNK_SIZE)
                    output.flush()
                    os.fsync(output.fileno())
                os.chmod(target, 0o644)
        os.replace(temporary, destination_path)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return {**inspection, "destination": str(destination_path)}
