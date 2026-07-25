from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


BUNDLED_TEMPLATE_PATH = Path(__file__).with_name("caption_prompt_templates.json")
LOCAL_TEMPLATE_DIRECTORY = Path(__file__).resolve().parents[3] / "config" / "caption_prompt_templates"


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _validated_template(template_id: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"Caption prompt template '{template_id}' must be a JSON object")
    prompt = str(value.get("prompt") or "").strip()
    if not prompt:
        raise ValueError(f"Caption prompt template '{template_id}' has no prompt")
    return value


def load_caption_prompt_templates(
    bundled_path: Path = BUNDLED_TEMPLATE_PATH,
    local_directory: Path = LOCAL_TEMPLATE_DIRECTORY,
) -> dict[str, dict[str, Any]]:
    bundled_data = _read_json(bundled_path)
    if not isinstance(bundled_data, dict):
        raise ValueError("Bundled caption prompt templates must be a JSON object")

    templates = {
        template_id: _validated_template(template_id, value)
        for template_id, value in bundled_data.items()
    }
    if not local_directory.is_dir():
        return templates

    for template_path in sorted(local_directory.glob("*.json")):
        if template_path.name == "index.json":
            continue
        template_id = template_path.stem
        try:
            templates[template_id] = _validated_template(template_id, _read_json(template_path))
        except (OSError, json.JSONDecodeError, ValueError):
            # A malformed unrelated variation should not make every caption job fail.
            # Requesting that ID still produces the normal unknown-template error.
            continue
    return templates


@lru_cache(maxsize=1)
def get_caption_prompt_templates() -> dict[str, dict[str, Any]]:
    return load_caption_prompt_templates()


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
