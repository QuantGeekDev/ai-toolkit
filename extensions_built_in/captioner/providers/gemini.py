from __future__ import annotations

import json
import os
import unicodedata
from typing import Any

from .base import (
    CaptionRequest,
    CaptionResult,
    ProviderAuthenticationError,
    ProviderCapabilities,
    ProviderConfigurationError,
    ProviderModelError,
    ProviderRateLimitError,
    ProviderResponseError,
    ProviderSafetyError,
    ProviderTransientError,
    UsageMetrics,
)


class GeminiCaptionProvider:
    capabilities = ProviderCapabilities()

    def __init__(
        self,
        *,
        model: str,
        thinking_level: str = "high",
        media_resolution: str = "high",
        max_output_tokens: int = 2048,
        max_attempts: int = 4,
        request_timeout_seconds: int = 120,
        api_key: str | None = None,
        client: Any | None = None,
    ):
        self.model = model.strip()
        self.thinking_level = thinking_level.lower()
        self.media_resolution = media_resolution.lower()
        self.max_output_tokens = max_output_tokens
        self.max_attempts = max_attempts
        self.request_timeout_seconds = request_timeout_seconds
        self._owns_client = client is None
        self._client = client
        self._api_key = api_key or os.environ.get("GEMINI_API_KEY", "")
        self.validate_configuration()
        if self._client is None:
            self._client = self._build_client()

    def validate_configuration(self) -> None:
        if not self.model:
            raise ProviderConfigurationError("Gemini model is required")
        if self.thinking_level not in {"low", "medium", "high"}:
            raise ProviderConfigurationError("Gemini thinking_level must be low, medium, or high")
        if self.media_resolution not in {"low", "medium", "high", "ultra_high"}:
            raise ProviderConfigurationError(
                "Gemini media_resolution must be low, medium, high, or ultra_high"
            )
        if not 256 <= self.max_output_tokens <= 65_536:
            raise ProviderConfigurationError("max_output_tokens must be between 256 and 65536")
        if not 1 <= self.max_attempts <= 6:
            raise ProviderConfigurationError("max_attempts must be between 1 and 6")
        if not 10 <= self.request_timeout_seconds <= 600:
            raise ProviderConfigurationError("request_timeout_seconds must be between 10 and 600")
        if self._client is None and not self._api_key.strip():
            raise ProviderConfigurationError(
                "Gemini API key is not configured. Set GEMINI_API_KEY or save it in Settings."
            )

    def _build_client(self):
        try:
            from google import genai
            from google.genai import types
        except ImportError as exc:
            raise ProviderConfigurationError(
                "Gemini support requires google-genai. Install the updated AI Toolkit requirements."
            ) from exc

        retry_options = types.HttpRetryOptions(
            attempts=self.max_attempts,
            initial_delay=1.0,
            max_delay=30.0,
            exp_base=2.0,
            jitter=1.0,
            http_status_codes=[408, 429, 500, 502, 503, 504],
        )
        return genai.Client(
            api_key=self._api_key,
            http_options=types.HttpOptions(
                timeout=self.request_timeout_seconds * 1000,
                retry_options=retry_options,
            ),
        )

    def _generation_config(self, max_output_tokens: int):
        from google.genai import types

        return types.GenerateContentConfig(
            max_output_tokens=max_output_tokens,
            response_mime_type="application/json",
            response_json_schema={
                "type": "object",
                "properties": {
                    "caption": {
                        "type": "string",
                        "description": "The final training caption, with no preamble.",
                    }
                },
                "required": ["caption"],
                "additionalProperties": False,
            },
            thinking_config=types.ThinkingConfig(
                thinking_level=self.thinking_level.upper()
            ),
        )

    def _request_once(self, request: CaptionRequest, max_output_tokens: int):
        from google.genai import types

        resolution = f"MEDIA_RESOLUTION_{self.media_resolution.upper()}"
        image_part = types.Part.from_bytes(
            data=request.image_bytes,
            mime_type=request.mime_type,
            media_resolution=resolution,
        )
        return self._client.models.generate_content(
            model=self.model,
            contents=[request.prompt, image_part],
            config=self._generation_config(max_output_tokens),
        )

    @staticmethod
    def _request_id(response: Any) -> str | None:
        sdk_response = getattr(response, "sdk_http_response", None)
        headers = getattr(sdk_response, "headers", None) or {}
        return headers.get("x-request-id") or headers.get("x-goog-request-id")

    @staticmethod
    def _finish_reason(response: Any) -> str:
        candidates = getattr(response, "candidates", None) or []
        if not candidates:
            prompt_feedback = getattr(response, "prompt_feedback", None)
            block_reason = getattr(prompt_feedback, "block_reason", "")
            if block_reason:
                return str(getattr(block_reason, "value", block_reason) or "").upper()
            return ""
        reason = getattr(candidates[0], "finish_reason", "")
        return str(getattr(reason, "value", reason) or "").upper()

    @staticmethod
    def _usage(response: Any) -> UsageMetrics | None:
        usage = getattr(response, "usage_metadata", None)
        if usage is None:
            return None
        return UsageMetrics(
            input_tokens=getattr(usage, "prompt_token_count", None),
            output_tokens=getattr(usage, "candidates_token_count", None),
            thoughts_tokens=getattr(usage, "thoughts_token_count", None),
            total_tokens=getattr(usage, "total_token_count", None),
        )

    @staticmethod
    def _parse_caption(response: Any) -> str:
        parsed = getattr(response, "parsed", None)
        if parsed is not None:
            if hasattr(parsed, "model_dump"):
                parsed = parsed.model_dump()
            if isinstance(parsed, dict):
                caption = parsed.get("caption")
            else:
                caption = getattr(parsed, "caption", None)
        else:
            text = getattr(response, "text", None)
            if not text:
                raise ProviderResponseError("Gemini returned no caption text")
            try:
                caption = json.loads(text).get("caption")
            except (json.JSONDecodeError, AttributeError) as exc:
                raise ProviderResponseError("Gemini returned invalid structured output") from exc

        if not isinstance(caption, str) or not caption.strip():
            raise ProviderResponseError("Gemini returned an empty caption")
        caption = unicodedata.normalize("NFC", caption.replace("\x00", "")).strip()
        if len(caption) > 20_000:
            raise ProviderResponseError("Gemini caption exceeded the 20000 character safety limit")
        return caption

    def _translate_error(self, exc: Exception):
        code = getattr(exc, "code", None)
        try:
            code = int(code)
        except (TypeError, ValueError):
            code = None
        message = str(exc)
        if self._api_key:
            message = message.replace(self._api_key, "[REDACTED]")
        safe_message = message[:500]
        if code in {401, 403}:
            return ProviderAuthenticationError(
                "Gemini rejected the API key or it lacks access to the selected model"
            )
        if code == 404:
            return ProviderModelError("Gemini model was not found or is no longer available")
        if code == 429:
            return ProviderRateLimitError("Gemini rate limit was exhausted after retries")
        if code in {408, 499, 500, 502, 503, 504} or isinstance(exc, TimeoutError):
            return ProviderTransientError(f"Gemini request failed after retries: {safe_message}")
        if code == 400:
            return ProviderConfigurationError(f"Gemini rejected the request: {safe_message}")
        return ProviderResponseError(f"Gemini request failed: {safe_message}")

    def caption(self, request: CaptionRequest) -> CaptionResult:
        try:
            attempts = 1
            response = self._request_once(request, self.max_output_tokens)
            finish_reason = self._finish_reason(response)
            if finish_reason in {"SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT"}:
                raise ProviderSafetyError(f"Gemini blocked the image ({finish_reason})")
            if finish_reason == "MAX_TOKENS":
                retry_tokens = min(65_536, self.max_output_tokens * 2)
                if retry_tokens == self.max_output_tokens:
                    raise ProviderResponseError("Gemini exhausted the output token limit")
                response = self._request_once(request, retry_tokens)
                attempts = 2
                finish_reason = self._finish_reason(response)
                if finish_reason == "MAX_TOKENS":
                    raise ProviderResponseError("Gemini exhausted the output token limit after retry")
            caption = self._parse_caption(response)
            return CaptionResult(
                caption=caption,
                provider="gemini",
                model=self.model,
                request_id=self._request_id(response),
                usage=self._usage(response),
                attempts=attempts,
            )
        except (
            ProviderConfigurationError,
            ProviderAuthenticationError,
            ProviderModelError,
            ProviderRateLimitError,
            ProviderTransientError,
            ProviderSafetyError,
            ProviderResponseError,
        ):
            raise
        except Exception as exc:
            raise self._translate_error(exc) from exc

    def close(self) -> None:
        if self._owns_client and self._client is not None:
            close = getattr(self._client, "close", None)
            if callable(close):
                close()
