#!/usr/bin/env python3
"""Plan or create the reusable zero-volume RunPod ComfyUI template."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

REST_BASE = "https://rest.runpod.io/v1"
IMAGE = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$", re.I)


class ProvisionError(RuntimeError):
    pass


def request(api_key: str, method: str, route: str, body: dict[str, Any] | None = None) -> Any:
    encoded = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
    req = urllib.request.Request(
        f"{REST_BASE}/{route.lstrip('/')}",
        data=encoded,
        method=method,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "User-Agent": "ai-toolkit-comfy/1.0",
            **({"Content-Type": "application/json"} if encoded else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            data = response.read()
            return json.loads(data) if data else {}
    except urllib.error.HTTPError as error:
        message = error.read().decode(errors="replace").replace(api_key, "[REDACTED]")
        raise ProvisionError(f"RunPod HTTP {error.code}: {message[:1000]}") from None


def rows(value: Any, key: str) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict) and isinstance(value.get(key), list):
        return [item for item in value[key] if isinstance(item, dict)]
    return []


def template_spec(name: str, image: str, hf_secret: str, registry_auth_id: str = "") -> dict[str, Any]:
    return {
        "category": "NVIDIA",
        "containerDiskInGb": 100,
        **({"containerRegistryAuthId": registry_auth_id} if registry_auth_id else {}),
        "dockerEntrypoint": [],
        "dockerStartCmd": [],
        "env": {
            "AITK_IMAGE_DIGEST": image,
            "HF_TOKEN": f"{{{{ RUNPOD_SECRET_{hf_secret} }}}}",
        },
        "imageName": image,
        "isPublic": False,
        "isServerless": False,
        "name": name,
        "ports": ["8188/http", "22/tcp"],
        "readme": "AI Toolkit ephemeral Krea 2 Turbo BF16 ComfyUI; no persistent or network volume",
        "volumeInGb": 0,
    }


def equivalent(actual: dict[str, Any], expected: dict[str, Any]) -> bool:
    image = actual.get("imageName", actual.get("image_name", actual.get("image")))
    disk = actual.get("containerDiskInGb", actual.get("container_disk_in_gb"))
    volume = actual.get("volumeInGb", actual.get("volume_in_gb", 0))
    ports = actual.get("ports", [])
    if isinstance(ports, str):
        ports = [item.strip() for item in ports.split(",") if item.strip()]
    environment = actual.get("env", actual.get("environment", {}))
    entrypoint = actual.get("dockerEntrypoint", actual.get("docker_entrypoint", []))
    return (
        image == expected["imageName"]
        and int(disk) == 100
        and int(volume or 0) == 0
        and not actual.get("networkVolumeId", actual.get("network_volume_id"))
        and sorted(ports) == sorted(expected["ports"])
        and environment == expected["env"]
        and entrypoint == []
        and actual.get("dockerStartCmd", actual.get("docker_start_cmd", [])) == []
        and (
            actual.get("containerRegistryAuthId", actual.get("container_registry_auth_id", "")) or ""
        )
        == expected.get("containerRegistryAuthId", "")
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--name", default="aitk-comfy-krea2-turbo")
    parser.add_argument("--hf-secret-name", default="aitk_hf_read")
    parser.add_argument(
        "--registry-auth-id",
        default=os.environ.get("RUNPOD_COMFY_REGISTRY_AUTH_ID", "").strip(),
        help="RunPod container registry credential ID for a private image",
    )
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    if not IMAGE.fullmatch(args.image):
        raise ProvisionError("--image must be an immutable image@sha256 digest")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{2,62}", args.name):
        raise ProvisionError("--name is invalid")
    api_key = os.environ.get("RUNPOD_API_KEY", "").strip()
    if not api_key:
        raise ProvisionError("RUNPOD_API_KEY must be provided through the environment")
    expected = template_spec(args.name, args.image, args.hf_secret_name, args.registry_auth_id)
    templates = rows(request(api_key, "GET", "templates"), "templates")
    matches = [item for item in templates if item.get("name") == args.name]
    if len(matches) > 1:
        raise ProvisionError("Multiple templates have the exact managed name")
    if matches and not equivalent(matches[0], expected):
        raise ProvisionError("Existing managed template has drift; it was not modified")
    if matches:
        template = matches[0]
        action = "reuse"
    elif args.apply:
        template = request(api_key, "POST", "templates", expected)
        if not isinstance(template, dict) or not template.get("id"):
            raise ProvisionError("RunPod did not return a template ID")
        action = "created"
    else:
        template = None
        action = "create"
    result = {
        "schemaVersion": 1,
        "mode": "apply" if args.apply else "plan",
        "action": action,
        "name": args.name,
        "templateId": template.get("id") if template else None,
        "image": args.image,
        "ports": expected["ports"],
        "containerDiskInGb": 100,
        "volumeInGb": 0,
        "networkVolumeId": None,
        "privateRegistryCredentialUsed": bool(args.registry_auth_id),
    }
    rendered = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output:
        temporary = args.output.with_name(f".{args.output.name}.{os.getpid()}.tmp")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(rendered, encoding="utf-8")
        os.replace(temporary, args.output)
    sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ProvisionError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(2) from None
