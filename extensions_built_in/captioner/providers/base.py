from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol


@dataclass(frozen=True)
class ProviderCapabilities:
    structured_output: bool = True
    usage_metadata: bool = True
    request_ids: bool = True


@dataclass(frozen=True)
class CaptionRequest:
    image_bytes: bytes
    mime_type: str
    prompt: str
    source_name: str


@dataclass(frozen=True)
class UsageMetrics:
    input_tokens: int | None = None
    output_tokens: int | None = None
    thoughts_tokens: int | None = None
    total_tokens: int | None = None


@dataclass(frozen=True)
class CaptionResult:
    caption: str
    provider: str
    model: str
    request_id: str | None = None
    usage: UsageMetrics | None = None
    attempts: int = 1
    metadata: Mapping[str, Any] = field(default_factory=dict)


class CaptionProviderError(RuntimeError):
    category = "provider_error"
    job_fatal = False

    def __init__(self, message: str, *, request_id: str | None = None):
        super().__init__(message)
        self.request_id = request_id


class ProviderConfigurationError(CaptionProviderError):
    category = "configuration"
    job_fatal = True


class ProviderAuthenticationError(CaptionProviderError):
    category = "authentication"
    job_fatal = True


class ProviderModelError(CaptionProviderError):
    category = "model"
    job_fatal = True


class ProviderRateLimitError(CaptionProviderError):
    category = "rate_limit"


class ProviderTransientError(CaptionProviderError):
    category = "transient"


class ProviderSafetyError(CaptionProviderError):
    category = "safety"


class ProviderResponseError(CaptionProviderError):
    category = "response"


class ProviderCancelledError(CaptionProviderError):
    category = "cancelled"


class CaptionProvider(Protocol):
    capabilities: ProviderCapabilities

    def validate_configuration(self) -> None: ...

    def caption(self, request: CaptionRequest) -> CaptionResult: ...

    def close(self) -> None: ...
