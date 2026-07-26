#!/usr/bin/env python3
"""Create the narrowly-scoped RunPod resources required by remote training.

The command is plan-only unless --apply is supplied. It reads the RunPod API
key from the environment and never writes credentials to its output file.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


REST_BASE_URL = "https://rest.runpod.io/v1"
DEFAULT_GPU_TYPE = "NVIDIA H100 80GB HBM3"
IMAGE_DIGEST_PATTERN = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$", re.IGNORECASE)
GITHUB_REPOSITORY_PATTERN = re.compile(
    r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$",
    re.IGNORECASE,
)
GIT_COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$", re.IGNORECASE)


class ProvisionError(RuntimeError):
    pass


def _redact(value: object, secrets: tuple[str, ...]) -> str:
    message = str(value)
    for secret in secrets:
        if secret:
            message = message.replace(secret, "[REDACTED]")
    message = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+", r"\1[REDACTED]", message)
    return message[:2000]


class RunPodRestClient:
    def __init__(
        self,
        api_key: str,
        base_url: str = REST_BASE_URL,
        opener: Callable[..., Any] = urllib.request.urlopen,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._opener = opener

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        encoded = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            f"{self._base_url}/{path.lstrip('/')}",
            data=encoded,
            method=method,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Accept": "application/json",
                **({"Content-Type": "application/json"} if encoded is not None else {}),
            },
        )
        attempts = 4 if method == "GET" else 1
        for attempt in range(attempts):
            try:
                with self._opener(request, timeout=30) as response:
                    payload = response.read()
                    return json.loads(payload.decode("utf-8")) if payload else {}
            except urllib.error.HTTPError as error:
                response_body = error.read().decode("utf-8", errors="replace")
                if method == "GET" and error.code in {408, 429, 500, 502, 503, 504} and attempt + 1 < attempts:
                    time.sleep(min(4.0, 0.25 * (2**attempt)))
                    continue
                raise ProvisionError(
                    f"RunPod {method} {path} failed with HTTP {error.code}: "
                    f"{_redact(response_body, (self._api_key,))}"
                ) from None
            except (OSError, TimeoutError) as error:
                if method == "GET" and attempt + 1 < attempts:
                    time.sleep(min(4.0, 0.25 * (2**attempt)))
                    continue
                action = "may have succeeded; inspect RunPod before retrying" if method == "POST" else "failed"
                raise ProvisionError(
                    f"RunPod {method} {path} {action}: {_redact(error, (self._api_key,))}"
                ) from None
        raise ProvisionError(f"RunPod {method} {path} exhausted retries")

    def list(self, resource: str) -> list[dict[str, Any]]:
        response = self.request("GET", resource)
        if isinstance(response, list):
            return [item for item in response if isinstance(item, dict)]
        if isinstance(response, dict):
            for key in ("items", "data", resource):
                items = response.get(key)
                if isinstance(items, list):
                    return [item for item in items if isinstance(item, dict)]
        raise ProvisionError(f"RunPod GET {resource} returned an unsupported response shape")

    def create(self, resource: str, body: dict[str, Any]) -> dict[str, Any]:
        response = self.request("POST", resource, body)
        if isinstance(response, dict) and isinstance(response.get("data"), dict):
            response = response["data"]
        if not isinstance(response, dict) or not response.get("id"):
            raise ProvisionError(f"RunPod POST {resource} did not return a resource ID")
        return response


def _field(item: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in item:
            return item[name]
    return None


def _find_named(items: list[dict[str, Any]], name: str, resource: str) -> dict[str, Any] | None:
    matches = [item for item in items if str(item.get("name", "")) == name]
    if len(matches) > 1:
        raise ProvisionError(f"Multiple RunPod {resource} resources are named {name!r}; resolve the ambiguity manually")
    return matches[0] if matches else None


def _require_match(actual: Any, expected: Any, label: str) -> None:
    if str(actual) != str(expected):
        raise ProvisionError(f"Existing RunPod resource drift at {label}: expected {expected!r}, got {actual!r}")


def _list_field(item: dict[str, Any], *names: str) -> list[str]:
    value = _field(item, *names)
    raw = value if isinstance(value, list) else str(value or "").split(",")
    return [str(entry).strip() for entry in raw if str(entry).strip()]


@dataclass(frozen=True)
class ProvisionSpec:
    name_prefix: str
    datacenter_id: str
    volume_size_gb: int
    container_disk_gb: int
    worker_image: str
    gpu_type_id: str
    hf_secret_name: str
    execution_timeout_ms: int
    ttl_ms: int
    source_repository: str | None = None
    source_commit: str | None = None

    @property
    def volume_name(self) -> str:
        return f"{self.name_prefix}-volume"

    @property
    def template_name(self) -> str:
        return f"{self.name_prefix}-worker"

    @property
    def endpoint_name(self) -> str:
        return f"{self.name_prefix}-endpoint"


def _volume_body(spec: ProvisionSpec) -> dict[str, Any]:
    return {"dataCenterId": spec.datacenter_id, "name": spec.volume_name, "size": spec.volume_size_gb}


def _bootstrap_command(spec: ProvisionSpec) -> list[str]:
    if not spec.source_repository or not spec.source_commit:
        return []
    repository = shlex.quote(spec.source_repository)
    commit = shlex.quote(spec.source_commit.lower())
    command = "; ".join(
        (
            "set -euo pipefail",
            "cd /app/ai-toolkit",
            f"git fetch --depth 1 {repository} {commit}",
            f'test "$(git rev-parse FETCH_HEAD)" = {commit}',
            "git checkout --detach FETCH_HEAD",
            f'test "$(git rev-parse HEAD)" = {commit}',
            "PIP_BREAK_SYSTEM_PACKAGES=1 python -m pip install --no-cache-dir -r remote/runpod/requirements.txt",
            "exec python -u remote/runpod/handler.py",
        )
    )
    return ["bash", "-lc", command]


def _template_body(spec: ProvisionSpec) -> dict[str, Any]:
    environment = {
        "AITK_REQUIRE_H100": "1",
        "AITK_WORKER_IMAGE_DIGEST": spec.worker_image,
    }
    if spec.hf_secret_name:
        environment["HF_TOKEN"] = f"{{{{ RUNPOD_SECRET_{spec.hf_secret_name} }}}}"
    if spec.source_commit:
        environment.update(
            {
                "AITK_SOURCE_COMMIT": spec.source_commit.lower(),
                "AITK_TOOLKIT_ROOT": "/app/ai-toolkit",
                "AITK_RUNPOD_VOLUME_ROOT": "/runpod-volume/aitk",
                "PYTHONPATH": "/app/ai-toolkit",
                "PIP_BREAK_SYSTEM_PACKAGES": "1",
            }
        )
    return {
        "category": "NVIDIA",
        "containerDiskInGb": spec.container_disk_gb,
        "dockerStartCmd": _bootstrap_command(spec),
        "env": environment,
        "imageName": spec.worker_image,
        "isPublic": False,
        "isServerless": True,
        "name": spec.template_name,
        "ports": [],
        "readme": "AI Toolkit immutable remote-training worker",
        "volumeInGb": 0,
    }


def _endpoint_body(spec: ProvisionSpec, template_id: str, volume_id: str) -> dict[str, Any]:
    return {
        "computeType": "GPU",
        "dataCenterIds": [spec.datacenter_id],
        "executionTimeoutMs": spec.execution_timeout_ms,
        "gpuCount": 1,
        "gpuTypeIds": [spec.gpu_type_id],
        "idleTimeout": 5,
        "name": spec.endpoint_name,
        "networkVolumeId": volume_id,
        "scalerType": "QUEUE_DELAY",
        "scalerValue": 4,
        "templateId": template_id,
        "workersMax": 1,
        "workersMin": 0,
    }


def provision(client: RunPodRestClient, spec: ProvisionSpec, apply: bool) -> dict[str, Any]:
    actions: list[str] = []
    volume = _find_named(client.list("networkvolumes"), spec.volume_name, "network volume")
    if volume:
        _require_match(_field(volume, "dataCenterId", "data_center_id"), spec.datacenter_id, "network volume datacenter")
        _require_match(_field(volume, "size", "sizeInGb", "size_in_gb"), spec.volume_size_gb, "network volume size")
        actions.append("reuse network volume")
    elif apply:
        volume = client.create("networkvolumes", _volume_body(spec))
        actions.append("created network volume")
    else:
        actions.append("create network volume")

    template = _find_named(client.list("templates"), spec.template_name, "template")
    if template:
        _require_match(_field(template, "imageName", "image_name", "image"), spec.worker_image, "template image")
        _require_match(
            _field(template, "containerDiskInGb", "container_disk_in_gb"),
            spec.container_disk_gb,
            "template container disk",
        )
        _require_match(_field(template, "isServerless", "is_serverless"), True, "template isServerless")
        _require_match(
            _list_field(template, "dockerStartCmd", "docker_start_cmd"),
            _bootstrap_command(spec),
            "template dockerStartCmd",
        )
        template_environment = _field(template, "env", "environment")
        if not isinstance(template_environment, dict):
            raise ProvisionError("Existing RunPod resource drift at template environment: expected an object")
        _require_match(
            template_environment.get("AITK_WORKER_IMAGE_DIGEST"),
            spec.worker_image,
            "template AITK_WORKER_IMAGE_DIGEST",
        )
        _require_match(template_environment.get("AITK_REQUIRE_H100"), "1", "template AITK_REQUIRE_H100")
        if spec.source_commit:
            _require_match(
                template_environment.get("AITK_SOURCE_COMMIT"),
                spec.source_commit.lower(),
                "template AITK_SOURCE_COMMIT",
            )
            _require_match(
                template_environment.get("AITK_TOOLKIT_ROOT"),
                "/app/ai-toolkit",
                "template AITK_TOOLKIT_ROOT",
            )
            _require_match(
                template_environment.get("AITK_RUNPOD_VOLUME_ROOT"),
                "/runpod-volume/aitk",
                "template AITK_RUNPOD_VOLUME_ROOT",
            )
            _require_match(template_environment.get("PYTHONPATH"), "/app/ai-toolkit", "template PYTHONPATH")
        if spec.hf_secret_name:
            _require_match(
                template_environment.get("HF_TOKEN"),
                f"{{{{ RUNPOD_SECRET_{spec.hf_secret_name} }}}}",
                "template HF_TOKEN secret reference",
            )
        actions.append("reuse worker template")
    elif apply:
        template = client.create("templates", _template_body(spec))
        actions.append("created worker template")
    else:
        actions.append("create worker template")

    endpoint = _find_named(client.list("endpoints"), spec.endpoint_name, "endpoint")
    if endpoint:
        expected_template_id = str(template.get("id")) if template else None
        expected_volume_id = str(volume.get("id")) if volume else None
        if expected_template_id:
            _require_match(_field(endpoint, "templateId", "template_id"), expected_template_id, "endpoint template")
        if expected_volume_id:
            _require_match(
                _field(endpoint, "networkVolumeId", "network_volume_id"), expected_volume_id, "endpoint network volume"
            )
        _require_match(_field(endpoint, "computeType", "compute_type"), "GPU", "endpoint computeType")
        _require_match(_field(endpoint, "gpuCount", "gpu_count"), 1, "endpoint gpuCount")
        _require_match(_list_field(endpoint, "gpuTypeIds", "gpu_type_ids"), [spec.gpu_type_id], "endpoint GPU types")
        _require_match(
            _list_field(endpoint, "dataCenterIds", "data_center_ids"),
            [spec.datacenter_id],
            "endpoint datacenters",
        )
        _require_match(_field(endpoint, "idleTimeout", "idle_timeout"), 5, "endpoint idleTimeout")
        _require_match(
            _field(endpoint, "executionTimeoutMs", "execution_timeout_ms"),
            spec.execution_timeout_ms,
            "endpoint execution timeout",
        )
        _require_match(_field(endpoint, "scalerType", "scaler_type"), "QUEUE_DELAY", "endpoint scalerType")
        _require_match(_field(endpoint, "scalerValue", "scaler_value"), 4, "endpoint scalerValue")
        _require_match(_field(endpoint, "workersMin", "workers_min"), 0, "endpoint workersMin")
        _require_match(_field(endpoint, "workersMax", "workers_max"), 1, "endpoint workersMax")
        actions.append("reuse endpoint")
    elif apply:
        if not volume or not template:
            raise ProvisionError("Internal provisioning error: endpoint dependencies are unavailable")
        endpoint = client.create("endpoints", _endpoint_body(spec, str(template["id"]), str(volume["id"])))
        actions.append("created endpoint")
    else:
        actions.append("create endpoint")

    result: dict[str, Any] = {
        "schemaVersion": 1,
        "mode": "apply" if apply else "plan",
        "actions": actions,
        "names": {
            "networkVolume": spec.volume_name,
            "template": spec.template_name,
            "endpoint": spec.endpoint_name,
        },
    }
    if volume and template and endpoint:
        volume_id = str(volume["id"])
        result["resources"] = {
            "networkVolumeId": volume_id,
            "templateId": str(template["id"]),
            "endpointId": str(endpoint["id"]),
        }
        result["aiToolkitSettings"] = {
            "RUNPOD_ENDPOINT_ID": str(endpoint["id"]),
            "RUNPOD_NETWORK_VOLUME_ID": volume_id,
            "RUNPOD_S3_ENDPOINT": f"https://s3api-{spec.datacenter_id.lower()}.runpod.io",
            "RUNPOD_S3_REGION": spec.datacenter_id,
            "RUNPOD_S3_BUCKET": volume_id,
            "RUNPOD_WORKER_IMAGE_DIGEST": spec.worker_image,
            "RUNPOD_EXECUTION_TIMEOUT_MS": str(spec.execution_timeout_ms),
            "RUNPOD_TTL_MS": str(spec.ttl_ms),
        }
    return result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--datacenter-id", required=True, help="RunPod datacenter, e.g. EU-RO-1")
    parser.add_argument("--worker-image", required=True, help="Immutable registry image@sha256 digest")
    parser.add_argument(
        "--source-repository",
        help="Optional public GitHub repository to bootstrap over the immutable base image",
    )
    parser.add_argument(
        "--source-commit",
        help="Exact 40-character Git commit to fetch when --source-repository is used",
    )
    parser.add_argument("--name-prefix", default="aitk-krea2")
    parser.add_argument("--volume-size-gb", type=int, default=200)
    parser.add_argument("--container-disk-gb", type=int, default=30)
    parser.add_argument("--gpu-type-id", default=DEFAULT_GPU_TYPE)
    parser.add_argument("--hf-secret-name", default="aitk_hf_read")
    parser.add_argument("--execution-timeout-ms", type=int, default=10_800_000)
    parser.add_argument("--ttl-ms", type=int, default=21_600_000)
    parser.add_argument("--api-key-env", default="RUNPOD_API_KEY")
    parser.add_argument("--rest-base-url", default=REST_BASE_URL, help=argparse.SUPPRESS)
    parser.add_argument("--output", type=Path, help="Write non-secret result JSON to this path")
    parser.add_argument("--apply", action="store_true", help="Create missing resources; otherwise only show a plan")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{2,50}", args.name_prefix):
        raise ProvisionError("--name-prefix must be 3-51 letters, digits, underscores, or hyphens")
    if not re.fullmatch(r"[A-Z]{2,4}-[A-Z0-9]+-\d+", args.datacenter_id, re.IGNORECASE):
        raise ProvisionError("--datacenter-id must look like EU-RO-1")
    if not IMAGE_DIGEST_PATTERN.fullmatch(args.worker_image):
        raise ProvisionError("--worker-image must be an immutable image@sha256 digest")
    if bool(args.source_repository) != bool(args.source_commit):
        raise ProvisionError("--source-repository and --source-commit must be supplied together")
    if args.source_repository and not GITHUB_REPOSITORY_PATTERN.fullmatch(args.source_repository):
        raise ProvisionError("--source-repository must be a public https://github.com/OWNER/REPO.git URL")
    if args.source_commit and not GIT_COMMIT_PATTERN.fullmatch(args.source_commit):
        raise ProvisionError("--source-commit must be an exact 40-character hexadecimal Git commit")
    if args.volume_size_gb < 10:
        raise ProvisionError("--volume-size-gb must be at least 10")
    if args.container_disk_gb < 10:
        raise ProvisionError("--container-disk-gb must be at least 10")
    if args.ttl_ms <= args.execution_timeout_ms:
        raise ProvisionError("--ttl-ms must exceed --execution-timeout-ms")
    api_key = os.environ.get(args.api_key_env, "").strip()
    if not api_key:
        raise ProvisionError(f"Set {args.api_key_env} in the environment; credentials are never accepted as arguments")
    spec = ProvisionSpec(
        name_prefix=args.name_prefix,
        datacenter_id=args.datacenter_id.upper(),
        volume_size_gb=args.volume_size_gb,
        container_disk_gb=args.container_disk_gb,
        worker_image=args.worker_image,
        gpu_type_id=args.gpu_type_id,
        hf_secret_name=args.hf_secret_name,
        execution_timeout_ms=args.execution_timeout_ms,
        ttl_ms=args.ttl_ms,
        source_repository=args.source_repository,
        source_commit=args.source_commit.lower() if args.source_commit else None,
    )
    result = provision(RunPodRestClient(api_key, args.rest_base_url), spec, args.apply)
    rendered = f"{json.dumps(result, indent=2, sort_keys=True)}\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_name(f".{args.output.name}.{os.getpid()}.tmp")
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
