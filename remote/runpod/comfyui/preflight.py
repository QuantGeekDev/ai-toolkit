#!/usr/bin/env python3
"""Validate frozen model/provider contracts and optionally run the live EPH-01 gate."""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

GRAPHQL = "https://api.runpod.io/graphql"
REST = "https://rest.runpod.io/v1"
IMAGE = re.compile(r"^[^\s@]+@sha256:[0-9a-f]{64}$", re.I)
MANAGED_PREFIX = "aitk-comfy-capability-"


class GateError(RuntimeError):
    pass


def http_json(
    url: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    api_key: str | None = None,
    bearer: str | None = None,
    allow: set[int] = {200},
) -> tuple[int, Any]:
    data = json.dumps(body, separators=(",", ":")).encode() if body is not None else None
    authorization = bearer or api_key
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Accept": "application/json",
            "User-Agent": "ai-toolkit-comfy/1.0",
            **({"Content-Type": "application/json"} if data else {}),
            **({"Authorization": f"Bearer {authorization}"} if authorization else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            payload = response.read()
            value = json.loads(payload) if payload else {}
            if response.status not in allow:
                raise GateError(f"Unexpected HTTP {response.status}")
            return response.status, value
    except urllib.error.HTTPError as error:
        payload = error.read()
        value: Any
        try:
            value = json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            value = {}
        if error.code in allow:
            return error.code, value
        raise GateError(f"HTTP {error.code} from {urllib.parse.urlparse(url).hostname}") from None


def verify_hugging_face(manifest: dict[str, Any]) -> dict[str, Any]:
    _, model = http_json(
        f"https://huggingface.co/api/models/{manifest['repository']}/revision/{manifest['revision']}?blobs=true"
    )
    siblings = {item.get("rfilename"): item for item in model.get("siblings", [])}
    verified = []
    for expected in manifest["files"]:
        sibling = siblings.get(expected["path"])
        lfs = sibling.get("lfs", {}) if isinstance(sibling, dict) else {}
        if int(lfs.get("size", -1)) != expected["bytes"] or lfs.get("sha256") != expected["sha256"]:
            raise GateError(f"Hugging Face contract mismatch for {expected['path']}")
        verified.append(expected["path"])
    return {"repository": manifest["repository"], "revision": manifest["revision"], "files": verified}


def graphql(api_key: str, query: str, variables: dict[str, Any]) -> Any:
    _, response = http_json(
        GRAPHQL,
        method="POST",
        body={"query": query, "variables": variables},
        api_key=api_key,
    )
    if response.get("errors"):
        messages = " ".join(str(item.get("message", "")) for item in response["errors"])
        raise GateError(f"RunPod GraphQL rejected the request: {messages[:500]}")
    return response.get("data", {})


def verify_provider_contract(api_key: str) -> dict[str, Any]:
    query = """query Contract {
      __type(name: "PodFindAndDeployOnDemandInput") {
        inputFields { name }
      }
    }"""
    fields: list[str] = []
    try:
        data = graphql(api_key, query, {})
        fields = [item["name"] for item in data.get("__type", {}).get("inputFields", [])]
    except GateError:
        # Some production GraphQL deployments disable introspection. The live
        # gate below remains authoritative for terminateAfter.
        fields = []
    required = {"cloudType", "containerDiskInGb", "gpuTypeId", "imageName", "ports", "volumeInGb", "terminateAfter"}
    source_contract: dict[str, Any] | None = None
    if fields:
        missing = sorted(required - set(fields))
        if missing:
            raise GateError(f"RunPod Pod create input is missing: {', '.join(missing)}")
    else:
        _, commit = http_json("https://api.github.com/repos/runpod/runpodctl/commits/main")
        commit_sha = str(commit.get("sha", ""))
        if not re.fullmatch(r"[0-9a-f]{40}", commit_sha):
            raise GateError("Could not pin the current official runpodctl source")
        source_url = f"https://raw.githubusercontent.com/runpod/runpodctl/{commit_sha}/internal/api/graphql.go"
        source_request = urllib.request.Request(source_url, headers={"User-Agent": "ai-toolkit-comfy/1.0"})
        with urllib.request.urlopen(source_request, timeout=30) as response:
            source = response.read().decode("utf-8")
        missing = sorted(field for field in required if f'json:"{field}' not in source)
        if "podFindAndDeployOnDemand(input: $input)" not in source or missing:
            raise GateError(f"Official runpodctl create contract is missing: {', '.join(missing)}")
        fields = sorted(required)
        source_contract = {"repository": "runpod/runpodctl", "commit": commit_sha, "file": "internal/api/graphql.go"}
    gpu_data = graphql(
        api_key,
        "query GpuTypes { gpuTypes { id displayName memoryInGb secureCloud securePrice } }",
        {},
    )
    gpus = gpu_data.get("gpuTypes", [])
    h100 = []
    for item in gpus:
        name = str(item.get("id") or item.get("displayName") or item.get("display_name") or "")
        secure = item.get("secureCloud", item.get("secure_cloud", item.get("secure", True)))
        if "H100" in name and secure is not False:
            h100.append(name)
    if not h100:
        raise GateError("RunPod returned no Secure Cloud H100 GPU types")
    return {
        "inputFields": fields,
        "inputContractSource": source_contract or "RunPod GraphQL introspection",
        "secureH100GpuTypes": sorted(set(h100)),
    }


CREATE = """mutation createPod($input: PodFindAndDeployOnDemandInput!) {
  podFindAndDeployOnDemand(input: $input) {
    id name imageName desiredStatus costPerHr containerDiskInGb volumeInGb ports
    machine { gpuDisplayName location }
    runtime { ports { ip isIpPublic privatePort publicPort type } }
  }
}"""


def create_probe(
    api_key: str,
    *,
    name: str,
    image: str,
    token: str,
    expires: datetime,
    cross_target: str = "",
) -> dict[str, Any]:
    environment = {
        "AITK_CAPABILITY_MODE": "1",
        "AITK_CAPABILITY_TOKEN": token,
        "AITK_IMAGE_DIGEST": image,
        **({"AITK_CAPABILITY_CROSS_TARGET": cross_target} if cross_target else {}),
    }
    data = graphql(
        api_key,
        CREATE,
        {
            "input": {
                "cloudType": "SECURE",
                "containerDiskInGb": 100,
                "env": [{"key": key, "value": value} for key, value in environment.items()],
                "gpuCount": 1,
                "gpuTypeId": "NVIDIA H100 80GB HBM3",
                "imageName": image,
                "name": name,
                "ports": "8188/http,22/tcp",
                "startSsh": True,
                "supportPublicIp": True,
                "volumeInGb": 0,
                "terminateAfter": expires.isoformat().replace("+00:00", "Z"),
            }
        },
    )
    pod = data.get("podFindAndDeployOnDemand")
    if not pod or not pod.get("id"):
        raise GateError("RunPod did not return a capability Pod ID")
    if pod.get("volumeInGb", 0) not in {0, None}:
        raise GateError("Capability Pod unexpectedly has persistent volume storage")
    if "H100" not in str(pod.get("machine", {}).get("gpuDisplayName", "")):
        raise GateError("Capability Pod is not an H100")
    return pod


def pod_get(api_key: str, pod_id: str) -> dict[str, Any] | None:
    status, value = http_json(f"{REST}/pods/{pod_id}", api_key=api_key, allow={200, 404})
    return None if status == 404 else value


def pod_runtime(api_key: str, pod_id: str) -> dict[str, Any]:
    data = graphql(
        api_key,
        """query Runtime {
          myself {
            pods {
              id
              runtime { ports { ip isIpPublic privatePort publicPort type } }
            }
          }
        }""",
        {},
    )
    pods = data.get("myself", {}).get("pods", [])
    return next((pod for pod in pods if pod.get("id") == pod_id), {})


def assert_runtime_ports(api_key: str, pod_id: str) -> dict[str, Any]:
    runtime = pod_runtime(api_key, pod_id).get("runtime") or {}
    ports = runtime.get("ports") or []
    ssh = next(
        (
            item
            for item in ports
            if int(item.get("privatePort", -1)) == 22
            and item.get("isIpPublic") is True
            and item.get("ip")
            and int(item.get("publicPort", 0)) > 0
        ),
        None,
    )
    if not ssh:
        raise GateError("RunPod did not expose the required public TCP mapping for port 22")
    return {"sshPublicIp": True, "sshPublicPort": int(ssh["publicPort"]), "httpProxy": True}


def delete_controller(api_key: str, pod_id: str) -> None:
    http_json(f"{REST}/pods/{pod_id}", method="DELETE", api_key=api_key, allow={200, 202, 204, 404})


def wait_proof(pod_id: str, token: str, timeout: float = 300) -> dict[str, Any]:
    deadline = time.time() + timeout
    url = f"https://{pod_id}-8188.proxy.runpod.net/proof"
    while time.time() < deadline:
        try:
            _, proof = http_json(url, bearer=token)
            return proof
        except (GateError, OSError):
            time.sleep(5)
    raise GateError("Capability probe did not become reachable")


def live_gate(api_key: str, image: str, hard_minutes: int, max_cost: float) -> dict[str, Any]:
    run_id = uuid.uuid4().hex[:12]
    pods: list[str] = []
    tokens: dict[str, str] = {}
    deadline = datetime.now(timezone.utc) + timedelta(minutes=hard_minutes)
    hard_pod_id = ""
    try:
        hard_token = secrets.token_urlsafe(32)
        hard = create_probe(
            api_key,
            name=f"{MANAGED_PREFIX}{run_id}-hard",
            image=image,
            token=hard_token,
            expires=deadline,
        )
        hard_pod_id = str(hard["id"])
        pods.append(hard_pod_id)
        tokens[hard_pod_id] = hard_token
        hourly_rate = float(hard.get("costPerHr", 0))
        if hourly_rate <= 0:
            raise GateError("RunPod did not attest the disposable H100 hourly rate")
        estimated_max_cost = hourly_rate * (hard_minutes / 60) * 2
        if estimated_max_cost > max_cost:
            raise GateError(
                f"Bounded live gate estimate ${estimated_max_cost:.2f} exceeds --max-cost ${max_cost:.2f}"
            )
        self_token = secrets.token_urlsafe(32)
        self_pod = create_probe(
            api_key,
            name=f"{MANAGED_PREFIX}{run_id}-self",
            image=image,
            token=self_token,
            expires=deadline,
            cross_target=hard_pod_id,
        )
        self_id = str(self_pod["id"])
        pods.append(self_id)
        tokens[self_id] = self_token
        software_contract: dict[str, Any] | None = None
        runtime_contract: dict[str, Any] | None = None
        for pod_id in pods:
            proof = wait_proof(pod_id, tokens[pod_id])
            if proof.get("podId") != pod_id or proof.get("podScopedKeyPresent") is not True:
                raise GateError("RunPod did not inject the expected Pod-scoped identity")
            if proof.get("controllerKeyInjected"):
                raise GateError("Capability Pod unexpectedly received a controller credential")
            software = proof.get("softwareContract")
            if (
                not isinstance(software, dict)
                or software.get("image") != image
                or software.get("comfyUiCommit") != "4800e78518ebb1f2a9443ea5418edbff6c3935f9"
                or "H100" not in str(software.get("gpu", "")).upper()
            ):
                raise GateError("Capability Pod returned an invalid software/GPU contract")
            software_contract = software_contract or software
            runtime_contract = assert_runtime_ports(api_key, pod_id)
        _, cross = http_json(
            f"https://{self_id}-8188.proxy.runpod.net/cross-delete",
            method="POST",
            body={},
            bearer=self_token,
        )
        if cross.get("status") not in {401, 403}:
            raise GateError(f"Pod-scoped key cross-delete returned unsafe HTTP {cross.get('status')}")
        _, self_result = http_json(
            f"https://{self_id}-8188.proxy.runpod.net/self-delete",
            method="POST",
            body={},
            bearer=self_token,
            allow={202},
        )
        if not self_result.get("accepted"):
            raise GateError("Self-delete was not accepted")
        for _ in range(36):
            if pod_get(api_key, self_id) is None:
                break
            time.sleep(5)
        else:
            raise GateError("Pod-scoped self-delete did not remove its own Pod")
        pods.remove(self_id)
        wait_seconds = max(0, deadline.timestamp() - time.time()) + 90
        end = time.time() + wait_seconds
        while time.time() < end:
            if pod_get(api_key, hard_pod_id) is None:
                pods.remove(hard_pod_id)
                break
            time.sleep(10)
        else:
            raise GateError("Provider terminateAfter did not remove the hard-deadline Pod")
        return {
            "runId": run_id,
            "image": image,
            "podScopedKeyPresent": True,
            "crossPodDeleteDenied": True,
            "selfDeleteConfirmed": True,
            "providerTerminateAfterConfirmed": True,
            "networkVolume": False,
            "persistentVolumeGb": 0,
            "estimatedMaximumCostUsd": round(estimated_max_cost, 4),
            "softwareContract": software_contract,
            "runtimeContract": runtime_contract,
        }
    finally:
        for pod_id in pods:
            try:
                delete_controller(api_key, pod_id)
            except Exception:
                pass
        # Sweep only this exact, random managed run prefix.
        try:
            _, value = http_json(f"{REST}/pods", api_key=api_key)
            current = value if isinstance(value, list) else value.get("pods", [])
            for pod in current:
                if str(pod.get("name", "")).startswith(f"{MANAGED_PREFIX}{run_id}-"):
                    delete_controller(api_key, str(pod["id"]))
        except Exception:
            pass


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--image", help="Immutable capability/production image digest for --live")
    parser.add_argument("--hard-deadline-minutes", type=int, default=15)
    parser.add_argument("--max-cost", type=float, help="Maximum estimated USD for the two-Pod live gate")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    api_key = os.environ.get("RUNPOD_API_KEY", "").strip()
    if not api_key:
        raise GateError("RUNPOD_API_KEY must be provided through the environment")
    manifest = json.loads((Path(__file__).parent / "model-manifest.json").read_text(encoding="utf-8"))
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "huggingFace": verify_hugging_face(manifest),
        "runpod": verify_provider_contract(api_key),
        "encryptedPodLocalVolume": {
            "adopted": False,
            "reason": "Container-only storage retained; no verified encrypted zero-network-volume API contract.",
        },
    }
    if args.live:
        if not args.image or not IMAGE.fullmatch(args.image):
            raise GateError("--live requires --image with an immutable image@sha256 digest")
        if not 3 <= args.hard_deadline_minutes <= 15:
            raise GateError("--hard-deadline-minutes must be 3-15")
        if args.max_cost is None or not 0 < args.max_cost <= 10:
            raise GateError("--live requires --max-cost between 0 and 10 USD")
        report["live"] = live_gate(api_key, args.image, args.hard_deadline_minutes, args.max_cost)
        _, pods_value = http_json(f"{REST}/pods", api_key=api_key)
        current = pods_value if isinstance(pods_value, list) else pods_value.get("pods", [])
        remaining = [
            {"id": str(pod.get("id", "")), "name": str(pod.get("name", ""))}
            for pod in current
            if str(pod.get("name", "")).startswith("aitk-comfy-")
        ]
        if remaining:
            raise GateError(f"Final RunPod sweep found {len(remaining)} managed ComfyUI Pod(s)")
        report["live"]["finalManagedPodCount"] = 0
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
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
    except GateError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(2) from None
