from __future__ import annotations

from collections import OrderedDict
import concurrent.futures
import json
import os
import re
import tempfile
import threading
from datetime import datetime, timezone

import tqdm
from jobs.process import BaseExtensionProcess

from .BaseCaptioner import BaseCaptioner
from .providers import (
    CaptionProviderError,
    CaptionRequest,
    ProviderConfigurationError,
    create_provider,
)
from .providers.image_utils import prepare_image
from .prompts.caption_prompt_templates import get_caption_prompt_template


class CloudCaptionConfig:
    def __init__(self, **kwargs):
        self.provider = str(kwargs.get("provider", "gemini")).strip().lower()
        self.model = str(
            kwargs.get("model")
            or kwargs.get("model_name_or_path")
            or "gemini-3.1-pro-preview"
        ).strip()
        self.extensions = kwargs.get("extensions") or ["jpg", "jpeg", "png", "bmp", "webp"]
        self.path_to_caption = kwargs.get("path_to_caption")
        self.caption_extension = str(kwargs.get("caption_extension", "txt")).lstrip(".")
        self.recaption = bool(kwargs.get("recaption", False))
        self.caption_prompt_template = str(kwargs.get("caption_prompt_template") or "").strip()
        raw_caption_prompt = kwargs.get("caption_prompt")
        if not str(raw_caption_prompt or "").strip() and self.caption_prompt_template:
            raw_caption_prompt = get_caption_prompt_template(self.caption_prompt_template)
        self.caption_prompt = str(
            raw_caption_prompt or "Describe this image in detail for image-model training."
        ).strip()
        self.concurrency = int(kwargs.get("concurrency", 2))
        self.request_timeout_seconds = int(kwargs.get("request_timeout_seconds", 120))
        self.max_attempts = int(kwargs.get("max_attempts", 4))
        self.max_output_tokens = int(kwargs.get("max_output_tokens", 2048))
        self.max_res = int(kwargs.get("max_res", 2048))
        self.max_payload_mb = int(kwargs.get("max_payload_mb", 15))
        self.provider_options = kwargs.get("provider_options") or {}
        self.device = "cpu"
        self.dtype = "float32"
        self.compile = False

        if not self.path_to_caption:
            raise ValueError("path_to_caption is required in config")
        if not os.path.isdir(self.path_to_caption):
            raise ValueError(f"Caption path does not exist: {self.path_to_caption}")
        if not self.extensions:
            raise ValueError("At least one extension is required in config")
        if not self.caption_prompt:
            raise ValueError("caption_prompt cannot be blank")
        if not re.fullmatch(r"[A-Za-z0-9_-]+", self.caption_extension):
            raise ValueError("caption_extension may contain only letters, numbers, _ and -")
        if not 1 <= self.concurrency <= 8:
            raise ValueError("concurrency must be between 1 and 8")
        if not 256 <= self.max_res <= 8192:
            raise ValueError("max_res must be between 256 and 8192")
        if not 1 <= self.max_payload_mb <= 18:
            raise ValueError("max_payload_mb must be between 1 and 18")
        normalized_keys = {str(key).lower().replace("-", "_") for key in self.provider_options}
        forbidden = {
            key
            for key in normalized_keys
            if key in {"api_key", "apikey", "key", "token", "credential", "secret"}
            or key.endswith("_api_key")
            or "credential" in key
            or key in {"adc_path", "google_application_credentials"}
        }
        if forbidden:
            raise ValueError("Credentials are not allowed in job configuration")
        if self.provider_options.get("store") not in {None, False}:
            raise ValueError("Cloud caption requests must remain stateless (store must be false)")
        if "thinking_budget" in self.provider_options:
            raise ValueError("Use thinking_level instead of the legacy thinking_budget option")


class CloudCaptioner(BaseCaptioner):
    caption_config_class = CloudCaptionConfig

    def __init__(self, process_id: int, job, config: OrderedDict, **kwargs):
        super().__init__(process_id, job, config, **kwargs)
        self.provider = None
        self._report_lock = threading.Lock()
        self._failure_report_initialized = False
        self.stats = {
            "captioned": 0,
            "failed": 0,
            "blocked": 0,
            "retried": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "thoughts_tokens": 0,
        }

    def load_model(self):
        options = dict(self.caption_config.provider_options)
        self.provider = create_provider(
            self.caption_config.provider,
            model=self.caption_config.model,
            backend=options.get("backend", "developer"),
            project=options.get("project"),
            location=options.get("location"),
            thinking_level=options.get("thinking_level", "high"),
            media_resolution=options.get("media_resolution", "high"),
            max_output_tokens=self.caption_config.max_output_tokens,
            max_attempts=self.caption_config.max_attempts,
            request_timeout_seconds=self.caption_config.request_timeout_seconds,
        )

    def run(self):
        BaseExtensionProcess.run(self)
        self.start_stop_watcher()
        self.update_status("running", "Connecting to caption provider")
        try:
            self.load_model()
            self.update_status("running", "Looking for files")
            self.find_files()
            self.update_db_key("total_steps", len(self.file_paths))
            self.update_step()
            self.update_status("running", f"Captioning {len(self.file_paths)} files with cloud API")
            self.run_caption_loop()
            summary = self._summary()
            self.update_status("completed", summary)
            print(f"\n{summary}")
        finally:
            if self.provider is not None:
                self.provider.close()

    def _caption_one(self, file_path: str):
        prepared = prepare_image(
            file_path,
            max_pixels=self.caption_config.max_res * self.caption_config.max_res,
            max_payload_bytes=self.caption_config.max_payload_mb * 1024 * 1024,
        )
        return self.provider.caption(
            CaptionRequest(
                image_bytes=prepared.data,
                mime_type=prepared.mime_type,
                prompt=self.caption_config.caption_prompt,
                source_name=os.path.basename(file_path),
            )
        )

    def run_caption_loop(self):
        if not self.file_paths:
            return
        iterator = iter(self.file_paths)
        pending = {}
        with concurrent.futures.ThreadPoolExecutor(
            max_workers=self.caption_config.concurrency,
            thread_name_prefix="cloud-caption",
        ) as pool, tqdm.tqdm(total=len(self.file_paths), desc="Captioning files", unit="file") as progress:
            for _ in range(min(self.caption_config.concurrency, len(self.file_paths))):
                file_path = next(iterator, None)
                if file_path is not None:
                    pending[pool.submit(self._caption_one, file_path)] = file_path

            while pending:
                done, _ = concurrent.futures.wait(
                    pending, return_when=concurrent.futures.FIRST_COMPLETED
                )
                for future in done:
                    file_path = pending.pop(future)
                    try:
                        result = future.result()
                        self.save_caption_for_file(file_path, result.caption)
                        self.stats["captioned"] += 1
                        self.stats["retried"] += max(0, result.attempts - 1)
                        if result.usage:
                            self.stats["input_tokens"] += result.usage.input_tokens or 0
                            self.stats["output_tokens"] += result.usage.output_tokens or 0
                            self.stats["thoughts_tokens"] += result.usage.thoughts_tokens or 0
                    except CaptionProviderError as exc:
                        self._record_failure(file_path, exc)
                        if exc.job_fatal:
                            for queued in pending:
                                queued.cancel()
                            raise
                    except OSError:
                        for queued in pending:
                            queued.cancel()
                        raise
                    except Exception as exc:
                        self._record_failure(file_path, exc)
                    finally:
                        self.step_num += 1
                        self.update_step()
                        progress.update(1)

                    self.maybe_stop()
                    next_path = next(iterator, None)
                    if next_path is not None:
                        pending[pool.submit(self._caption_one, next_path)] = next_path

    def _failure_report_path(self) -> str:
        output_dir = os.environ.get("AITK_JOB_OUTPUT_DIR")
        if not output_dir:
            output_dir = os.path.dirname(os.path.abspath(self.sqlite_db_path))
        os.makedirs(output_dir, exist_ok=True)
        return os.path.join(output_dir, "caption_failures.jsonl")

    def _record_failure(self, file_path: str, exc: Exception):
        category = getattr(exc, "category", "unexpected")
        self.stats["failed"] += 1
        if category == "safety":
            self.stats["blocked"] += 1
        record = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "source": os.path.relpath(file_path, self.caption_config.path_to_caption),
            "provider": self.caption_config.provider,
            "model": self.caption_config.model,
            "category": category,
            "request_id": getattr(exc, "request_id", None),
            "message": str(exc)[:500],
        }
        print(f"Error captioning {record['source']} [{category}]: {record['message']}")
        try:
            with self._report_lock:
                mode = "a" if self._failure_report_initialized else "w"
                with open(self._failure_report_path(), mode, encoding="utf-8") as handle:
                    handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                self._failure_report_initialized = True
        except OSError as report_error:
            print(f"Warning: could not write caption failure report: {report_error}")

    def _summary(self) -> str:
        message = (
            f"Captioning completed: {self.stats['captioned']} captioned, "
            f"{self.stats['failed']} failed, {self.stats['blocked']} blocked, "
            f"{self.stats['retried']} retried"
        )
        if self.stats["failed"]:
            message += "; see caption_failures.jsonl in the job output folder"
        return message

    def get_caption_for_file(self, file_path: str) -> str:
        return self._caption_one(file_path).caption
