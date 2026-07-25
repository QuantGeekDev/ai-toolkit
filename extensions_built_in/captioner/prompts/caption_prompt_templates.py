from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


TEMPLATE_PATH = Path(__file__).with_name("caption_prompt_templates.json")


@lru_cache(maxsize=1)
def get_caption_prompt_templates() -> dict[str, dict[str, Any]]:
    with TEMPLATE_PATH.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("Caption prompt templates must be a JSON object")
    return data


def get_caption_prompt_template(template_id: str) -> str:
    template = get_caption_prompt_templates().get(template_id)
    if not template:
        available = ", ".join(sorted(get_caption_prompt_templates()))
        raise ValueError(
            f"Unknown caption_prompt_template '{template_id}'. Available templates: {available}"
        )
    prompt = str(template.get("prompt") or "").strip()
    if not prompt:
        raise ValueError(f"Caption prompt template '{template_id}' has no prompt")
    return prompt
