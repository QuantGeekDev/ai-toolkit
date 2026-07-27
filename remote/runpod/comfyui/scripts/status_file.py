#!/usr/bin/env python3
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

STATUS_PATH = Path(os.environ.get("AITK_STATUS_PATH", "/run/aitk/status.json"))


def read_status() -> dict[str, Any]:
    try:
        value = json.loads(STATUS_PATH.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def update_status(**fields: Any) -> dict[str, Any]:
    STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    value = read_status()
    value.update(fields)
    value["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    handle, temporary = tempfile.mkstemp(prefix=".status-", suffix=".json", dir=STATUS_PATH.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as output:
            json.dump(value, output, sort_keys=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, STATUS_PATH)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return value
