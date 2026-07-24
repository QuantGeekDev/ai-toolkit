from __future__ import annotations

from typing import Any

from .base import *
from .gemini import GeminiCaptionProvider


PROVIDER_REGISTRY = {
    "gemini": GeminiCaptionProvider,
}


def create_provider(provider: str, **kwargs: Any):
    provider_name = provider.strip().lower()
    provider_class = PROVIDER_REGISTRY.get(provider_name)
    if provider_class is None:
        supported = ", ".join(sorted(PROVIDER_REGISTRY))
        raise ProviderConfigurationError(
            f"Unknown caption provider '{provider}'. Supported providers: {supported}"
        )
    return provider_class(**kwargs)
