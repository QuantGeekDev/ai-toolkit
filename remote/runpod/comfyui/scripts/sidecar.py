#!/usr/bin/env python3
import asyncio
import base64
import hashlib
import hmac
import json
import os
import secrets
import shutil
import stat
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

import aiohttp
from aiohttp import web

from status_file import read_status, update_status

WORKSPACE_ID = os.environ["AITK_WORKSPACE_ID"]
CONTROLLER_TOKEN = os.environ["AITK_CONTROLLER_TOKEN"]
BROWSER_KEY_TEXT = os.environ["AITK_BROWSER_SIGNING_KEY"]
BROWSER_KEY = base64.urlsafe_b64decode(BROWSER_KEY_TEXT + "=" * (-len(BROWSER_KEY_TEXT) % 4))
POD_ID = os.environ["RUNPOD_POD_ID"]
POD_API_KEY = os.environ["RUNPOD_API_KEY"]
IDLE_MINUTES = int(os.environ.get("AITK_IDLE_MINUTES", "60"))
EXPIRES_AT = datetime.fromisoformat(os.environ["AITK_EXPIRES_AT"].replace("Z", "+00:00")).timestamp()
INCOMING_ROOT = Path("/srv/sftp/incoming")
COMFY_ROOT = Path("/workspace/comfy")
OUTPUT_ROOT = COMFY_ROOT / "output" / "ai-toolkit" / WORKSPACE_ID
COMFY_URL = "http://127.0.0.1:8189"
COOKIE = "__Host-aitk_session"
GRACE_SECONDS = 120
MAX_LOGIN_ATTEMPTS = 10

sessions: dict[str, float] = {}
used_nonces: dict[str, float] = {}
login_attempts: defaultdict[str, deque[float]] = defaultdict(deque)
installed = False
install_task: asyncio.Task[None] | None = None
last_user_activity: float | None = None
last_queue_activity: float | None = None
ready_at: float | None = None
idle_grace_at: float | None = None
termination_reason: str | None = None
queue_running = False
queue_pending = 0
queue_healthy = False
http_session: aiohttp.ClientSession

LANDING = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>AI Toolkit ComfyUI Workspace</title>
<style>body{font:16px system-ui;background:#111827;color:#e5e7eb;display:grid;place-items:center;min-height:100vh}
main{max-width:34rem;padding:2rem;border:1px solid #374151;border-radius:.75rem}button{padding:.65rem 1rem}</style></head>
<body><main><h1>AI Toolkit ComfyUI workspace</h1><p id="message">Establishing your authenticated session…</p>
<script>
(async()=>{const hash=new URLSearchParams(location.hash.slice(1));const token=hash.get("access_token");
history.replaceState(null,"",location.pathname+location.search);
if(!token){document.getElementById("message").textContent="Open this workspace from AI Toolkit.";return}
const response=await fetch("/aitk/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({assertion:token})});
if(response.ok){location.replace("/")}else{document.getElementById("message").textContent="This access link is invalid or expired. Open a new link from AI Toolkit."}})();
</script></main></body></html>"""


def iso(timestamp: float | None) -> str | None:
    if timestamp is None:
        return None
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def secure_equal(left: str, right: str) -> bool:
    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


def controller_authenticated(request: web.Request) -> bool:
    authorization = request.headers.get("Authorization", "")
    return authorization.startswith("Bearer ") and secure_equal(authorization[7:], CONTROLLER_TOKEN)


def browser_authenticated(request: web.Request) -> bool:
    token = request.cookies.get(COOKIE, "")
    expires = sessions.get(hashlib.sha256(token.encode("utf-8")).hexdigest())
    if not expires or expires <= time.time():
        return False
    return True


def status_payload() -> dict[str, Any]:
    value = read_status()
    value.update(
        {
            "workspaceId": WORKSPACE_ID,
            "ready": bool(
                ready_at
                and installed
                and value.get("modelsVerified")
                and value.get("comfyVerified")
            ),
            "queueRunning": queue_running,
            "queuePending": queue_pending,
            "queueStatusHealthy": queue_healthy,
            "lastUserActivityAt": iso(last_user_activity),
            "lastQueueActivityAt": iso(last_queue_activity),
            "readyAt": iso(ready_at),
            "idleGraceStartedAt": iso(idle_grace_at),
            "terminationReason": termination_reason,
            "hardExpiresAt": iso(EXPIRES_AT),
            "modelManifestSha256": os.environ["AITK_MODEL_MANIFEST_SHA256"],
            "imageDigest": os.environ["AITK_IMAGE_DIGEST"],
        }
    )
    try:
        value["sshHostKeyFingerprint"] = Path("/run/aitk-ssh-fingerprint").read_text(encoding="utf-8").strip()
    except OSError:
        value["sshHostKeyFingerprint"] = None
    return value


@web.middleware
async def auth_middleware(request: web.Request, handler):
    if request.path == "/aitk/session" or (request.path == "/" and not browser_authenticated(request)):
        return await handler(request)
    if request.path.startswith("/aitk/control/"):
        if not controller_authenticated(request):
            raise web.HTTPUnauthorized(text=json.dumps({"error": "Unauthorized"}), content_type="application/json")
        return await handler(request)
    if not browser_authenticated(request):
        raise web.HTTPUnauthorized(text=json.dumps({"error": "Open this workspace from AI Toolkit."}), content_type="application/json")
    return await handler(request)


def decode_assertion(value: str) -> dict[str, Any]:
    pieces = value.split(".")
    if len(pieces) != 2:
        raise ValueError("invalid assertion")
    payload_text, signature = pieces
    expected = base64.urlsafe_b64encode(hmac.new(BROWSER_KEY, payload_text.encode("ascii"), hashlib.sha256).digest()).rstrip(b"=").decode()
    if not secure_equal(signature, expected):
        raise ValueError("invalid assertion")
    payload = json.loads(base64.urlsafe_b64decode(payload_text + "=" * (-len(payload_text) % 4)))
    now = int(time.time())
    if (
        payload.get("v") != 1
        or payload.get("workspaceId") != WORKSPACE_ID
        or not isinstance(payload.get("nonce"), str)
        or int(payload.get("iat", 0)) > now + 30
        or int(payload.get("exp", 0)) < now
        or int(payload.get("exp", 0)) > now + 330
    ):
        raise ValueError("invalid assertion")
    if payload["nonce"] in used_nonces:
        raise ValueError("assertion already used")
    return payload


async def landing(request: web.Request) -> web.Response:
    if browser_authenticated(request):
        return await proxy(request)
    return web.Response(text=LANDING, content_type="text/html", headers={"Cache-Control": "no-store"})


async def create_session(request: web.Request) -> web.Response:
    ip = request.remote or "unknown"
    attempts = login_attempts[ip]
    now = time.time()
    while attempts and attempts[0] < now - 60:
        attempts.popleft()
    if len(attempts) >= MAX_LOGIN_ATTEMPTS:
        raise web.HTTPTooManyRequests(text=json.dumps({"error": "Try again later."}), content_type="application/json")
    attempts.append(now)
    try:
        body = await request.json()
        payload = decode_assertion(str(body.get("assertion", "")))
    except (ValueError, TypeError, json.JSONDecodeError):
        raise web.HTTPUnauthorized(text=json.dumps({"error": "Invalid or expired access link."}), content_type="application/json")
    used_nonces[payload["nonce"]] = float(payload["exp"])
    token = secrets.token_urlsafe(32)
    session_expiry = min(EXPIRES_AT, now + 12 * 60 * 60)
    sessions[hashlib.sha256(token.encode("utf-8")).hexdigest()] = session_expiry
    response = web.json_response({"ok": True})
    response.set_cookie(COOKIE, token, secure=True, httponly=True, samesite="Strict", path="/", max_age=max(1, int(session_expiry - now)))
    return response


async def logout(request: web.Request) -> web.Response:
    token = request.cookies.get(COOKIE, "")
    if token:
        sessions.pop(hashlib.sha256(token.encode("utf-8")).hexdigest(), None)
    response = web.json_response({"ok": True})
    response.del_cookie(COOKIE, path="/")
    return response


async def activity(request: web.Request) -> web.Response:
    global last_user_activity, idle_grace_at
    body = await request.json()
    if str(body.get("kind", "")) not in {"pointerdown", "keydown", "wheel", "touchstart", "visible", "prompt"}:
        raise web.HTTPBadRequest(text=json.dumps({"error": "Invalid activity type."}), content_type="application/json")
    last_user_activity = time.time()
    if not termination_reason:
        idle_grace_at = None
    update_status(lastUserActivityAt=iso(last_user_activity), idleGraceStartedAt=iso(idle_grace_at))
    return web.json_response({"ok": True})


async def control_status(_: web.Request) -> web.Response:
    return web.json_response(status_payload(), headers={"Cache-Control": "no-store"})


def safe_incoming(relative: str) -> Path:
    portable = PurePosixPath(relative)
    if not relative or portable.is_absolute() or "\\" in relative or any(part in {"", ".", ".."} for part in portable.parts):
        raise ValueError("unsafe manifest path")
    candidate = INCOMING_ROOT.joinpath(*portable.parts)
    root = INCOMING_ROOT.resolve()
    parent = candidate.parent
    while parent != INCOMING_ROOT.parent:
        info = parent.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise ValueError("manifest path traverses a symlink")
        if parent == INCOMING_ROOT:
            break
        parent = parent.parent
    if not candidate.resolve().is_relative_to(root):
        raise ValueError("manifest path escapes incoming root")
    info = candidate.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ValueError("manifest entry is not a regular file")
    return candidate


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def install_committed_bundle(expected_manifest_sha256: str) -> None:
    global installed
    marker = INCOMING_ROOT / "COMMITTED"
    manifest_path = INCOMING_ROOT / "workspace-manifest.json"
    if not marker.is_file() or marker.read_text(encoding="utf-8").strip() != "1":
        raise ValueError("workspace bundle is not committed")
    if sha256_file(manifest_path) != expected_manifest_sha256:
        raise ValueError("workspace manifest digest mismatch")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("workspaceId") != WORKSPACE_ID
        or manifest.get("model", {}).get("manifestSha256") != os.environ["AITK_MODEL_MANIFEST_SHA256"]
        or not isinstance(manifest.get("files"), list)
        or len(manifest["files"]) > 1000
    ):
        raise ValueError("workspace manifest identity is invalid")
    for item in manifest["files"]:
        relative = str(item.get("remotePath", ""))
        source = safe_incoming(relative)
        if source.stat().st_size != int(item.get("bytes", -1)) or sha256_file(source) != item.get("sha256"):
            raise ValueError(f"workspace artifact verification failed: {source.name}")
        if item.get("role") == "lora" and relative.startswith("loras/"):
            destination = COMFY_ROOT / "models" / relative
        elif item.get("role") == "workflow" and relative.startswith("workflows/"):
            destination = COMFY_ROOT / "user" / "default" / relative
        else:
            raise ValueError("workspace manifest contains an unsupported artifact role")
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.installing")
        with source.open("rb") as reader, temporary.open("xb") as writer:
            shutil.copyfileobj(reader, writer, length=8 * 1024 * 1024)
            writer.flush()
            os.fsync(writer.fileno())
        if temporary.stat().st_size != source.stat().st_size or sha256_file(temporary) != item["sha256"]:
            temporary.unlink(missing_ok=True)
            raise ValueError("installed artifact verification failed")
        os.replace(temporary, destination)
        source.unlink()
    installed = True


def stage_output_catalog() -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    total = 0
    now = time.time()
    outgoing = INCOMING_ROOT / "outputs"
    outgoing.mkdir(parents=True, exist_ok=True)
    if OUTPUT_ROOT.exists():
        for item in sorted(OUTPUT_ROOT.rglob("*")):
            info = item.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or now - info.st_mtime < 10:
                continue
            relative = item.relative_to(OUTPUT_ROOT).as_posix()
            portable = PurePosixPath(relative)
            if any(part in {"", ".", ".."} for part in portable.parts):
                continue
            total += info.st_size
            if len(files) >= 10000 or total > 50 * 1024**3:
                break
            destination = outgoing.joinpath(*portable.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not destination.exists() or destination.stat().st_size != info.st_size:
                temporary = destination.with_name(f".{destination.name}.copying")
                temporary.unlink(missing_ok=True)
                with item.open("rb") as reader, temporary.open("xb") as writer:
                    shutil.copyfileobj(reader, writer, length=8 * 1024 * 1024)
                    writer.flush()
                    os.fsync(writer.fileno())
                if item.stat().st_size != info.st_size or item.stat().st_mtime_ns != info.st_mtime_ns:
                    temporary.unlink(missing_ok=True)
                    continue
                os.replace(temporary, destination)
            files.append(
                {
                    "path": relative,
                    "remotePath": f"outputs/{relative}",
                    "bytes": destination.stat().st_size,
                    "sha256": sha256_file(destination),
                }
            )
    return {"workspaceId": WORKSPACE_ID, "files": files, "bytes": sum(item["bytes"] for item in files)}


async def install_worker(expected: str) -> None:
    try:
        update_status(phase="installing_bundle", ready=False)
        await asyncio.to_thread(install_committed_bundle, expected)
        update_status(phase="validating_comfyui", bundleInstalled=True)
    except Exception as error:
        update_status(phase="bundle_failed", ready=False, errorCode="BUNDLE_VALIDATION_FAILED", errorMessage=str(error)[:500])


async def control_install(request: web.Request) -> web.Response:
    global install_task
    body = await request.json()
    expected = str(body.get("manifestSha256", ""))
    if len(expected) != 64 or any(character not in "0123456789abcdef" for character in expected.lower()):
        raise web.HTTPBadRequest(text=json.dumps({"error": "Invalid manifest digest."}), content_type="application/json")
    if install_task is None or install_task.done():
        install_task = asyncio.create_task(install_worker(expected))
    return web.json_response(status_payload(), status=202)


async def control_terminate(request: web.Request) -> web.Response:
    global termination_reason, idle_grace_at
    body = await request.json()
    if body.get("mode") != "graceful":
        raise web.HTTPBadRequest(text=json.dumps({"error": "Only graceful remote termination is supported."}), content_type="application/json")
    if termination_reason != "controller_graceful":
        termination_reason = "controller_graceful"
        idle_grace_at = time.time()
    update_status(phase="termination_grace", terminationReason=termination_reason, idleGraceStartedAt=iso(idle_grace_at))
    return web.json_response(status_payload(), status=202)


async def output_catalog(_: web.Request) -> web.Response:
    try:
        catalog = await asyncio.to_thread(stage_output_catalog)
        return web.json_response(catalog)
    except Exception:
        raise web.HTTPInternalServerError(
            text=json.dumps({"error": "Could not prepare stable generated images."}),
            content_type="application/json",
        )


async def proxy_websocket(request: web.Request) -> web.StreamResponse:
    client = web.WebSocketResponse(heartbeat=30)
    await client.prepare(request)
    target = f"{COMFY_URL}{request.rel_url}"
    async with http_session.ws_connect(target, headers={"Origin": COMFY_URL}) as upstream:
        async def client_to_upstream():
            async for message in client:
                if message.type == aiohttp.WSMsgType.TEXT:
                    await upstream.send_str(message.data)
                elif message.type == aiohttp.WSMsgType.BINARY:
                    await upstream.send_bytes(message.data)
                elif message.type == aiohttp.WSMsgType.CLOSE:
                    await upstream.close()

        async def upstream_to_client():
            async for message in upstream:
                if message.type == aiohttp.WSMsgType.TEXT:
                    await client.send_str(message.data)
                elif message.type == aiohttp.WSMsgType.BINARY:
                    await client.send_bytes(message.data)
                elif message.type == aiohttp.WSMsgType.CLOSE:
                    await client.close()

        await asyncio.gather(client_to_upstream(), upstream_to_client())
    return client


async def proxy(request: web.Request) -> web.StreamResponse:
    if request.headers.get("Upgrade", "").lower() == "websocket":
        return await proxy_websocket(request)
    excluded = {"host", "authorization", "cookie", "connection", "content-length", "transfer-encoding"}
    headers = {key: value for key, value in request.headers.items() if key.lower() not in excluded}
    body = request.content.iter_chunked(1024 * 1024) if request.can_read_body else None
    async with http_session.request(request.method, f"{COMFY_URL}{request.rel_url}", headers=headers, data=body, allow_redirects=False) as upstream:
        response = web.StreamResponse(status=upstream.status)
        for key, value in upstream.headers.items():
            if key.lower() not in {"connection", "content-length", "transfer-encoding", "set-cookie"}:
                response.headers[key] = value
        await response.prepare(request)
        async for chunk in upstream.content.iter_chunked(1024 * 1024):
            await response.write(chunk)
        await response.write_eof()
        return response


async def observe_queue() -> None:
    global queue_running, queue_pending, queue_healthy, last_queue_activity, ready_at
    previous_busy = False
    while True:
        try:
            async with http_session.get(f"{COMFY_URL}/queue", timeout=aiohttp.ClientTimeout(total=5)) as response:
                body = await response.json()
                running = body.get("queue_running")
                pending = body.get("queue_pending")
                if not isinstance(running, list) or not isinstance(pending, list):
                    raise ValueError("malformed queue response")
                queue_running = bool(running)
                queue_pending = len(pending)
                queue_healthy = True
                busy = queue_running or queue_pending > 0
                if busy or busy != previous_busy:
                    last_queue_activity = time.time()
                previous_busy = busy
            current = read_status()
            if (
                installed
                and current.get("modelsVerified")
                and current.get("comfyVerified")
                and not current.get("errorCode")
            ):
                if ready_at is None:
                    ready_at = time.time()
                update_status(phase="ready", ready=True, readyAt=iso(ready_at))
        except Exception:
            queue_healthy = False
        await asyncio.sleep(10)


async def delete_self() -> None:
    global termination_reason
    url = f"https://rest.runpod.io/v1/pods/{POD_ID}"
    try:
        async with http_session.delete(
            url,
            headers={"Authorization": f"Bearer {POD_API_KEY}", "Accept": "application/json"},
            timeout=aiohttp.ClientTimeout(total=20),
        ) as response:
            if response.status not in {200, 202, 204, 404}:
                update_status(phase="self_delete_retry", errorCode="SELF_DELETE_FAILED", errorMessage=f"RunPod HTTP {response.status}")
                return
            update_status(phase="self_delete_requested", terminationReason=termination_reason)
    except Exception:
        update_status(phase="self_delete_retry", errorCode="SELF_DELETE_FAILED", errorMessage="RunPod deletion request failed")


async def watchdog() -> None:
    global idle_grace_at, termination_reason
    while True:
        now = time.time()
        for nonce, expiry in list(used_nonces.items()):
            if expiry < now:
                used_nonces.pop(nonce, None)
        for session_hash, expiry in list(sessions.items()):
            if expiry < now:
                sessions.pop(session_hash, None)
        if now >= EXPIRES_AT:
            termination_reason = "hard_expiry"
            update_status(phase="hard_expiry", terminationReason=termination_reason)
            await delete_self()
        elif ready_at and queue_healthy and not queue_running and queue_pending == 0:
            latest = max(value for value in (ready_at, last_user_activity, last_queue_activity) if value is not None)
            if termination_reason == "controller_graceful":
                idle_grace_at = idle_grace_at or now
            elif now - latest >= IDLE_MINUTES * 60 and idle_grace_at is None:
                idle_grace_at = now
                termination_reason = "idle"
                update_status(phase="idle_grace", idleGraceStartedAt=iso(idle_grace_at), terminationReason=termination_reason)
            if idle_grace_at and now - idle_grace_at >= GRACE_SECONDS:
                update_status(phase="idle_self_delete", terminationReason=termination_reason)
                await delete_self()
        await asyncio.sleep(10)


async def startup(app: web.Application) -> None:
    global http_session
    http_session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=None))
    app["queue_task"] = asyncio.create_task(observe_queue())
    app["watchdog_task"] = asyncio.create_task(watchdog())


async def cleanup(app: web.Application) -> None:
    for name in ("queue_task", "watchdog_task"):
        app[name].cancel()
    await http_session.close()


app = web.Application(middlewares=[auth_middleware], client_max_size=2 * 1024**3)
app.router.add_get("/", landing)
app.router.add_post("/aitk/session", create_session)
app.router.add_post("/aitk/logout", logout)
app.router.add_post("/aitk/activity", activity)
app.router.add_get("/aitk/control/status", control_status)
app.router.add_get("/aitk/control/health", control_status)
app.router.add_post("/aitk/control/install", control_install)
app.router.add_post("/aitk/control/terminate", control_terminate)
app.router.add_get("/aitk/control/outputs", output_catalog)
app.router.add_route("*", "/{tail:.*}", proxy)
app.on_startup.append(startup)
app.on_cleanup.append(cleanup)

if __name__ == "__main__":
    update_status(workspaceId=WORKSPACE_ID, phase="sidecar_starting", ready=False)
    web.run_app(app, host="0.0.0.0", port=8188, access_log=None)
