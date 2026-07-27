#!/usr/bin/env python3
"""Test-only endpoint for the bounded EPH-01 RunPod capability gate."""
import asyncio
import json
import os
import platform

import aiohttp
import torch
from aiohttp import web

TOKEN = os.environ["AITK_CAPABILITY_TOKEN"]
POD_ID = os.environ["RUNPOD_POD_ID"]
POD_KEY = os.environ.get("RUNPOD_API_KEY", "")
TARGET = os.environ.get("AITK_CAPABILITY_CROSS_TARGET", "")


def authorized(request: web.Request) -> bool:
    return request.headers.get("Authorization") == f"Bearer {TOKEN}"


async def proof(request: web.Request) -> web.Response:
    if not authorized(request):
        raise web.HTTPUnauthorized()
    return web.json_response(
        {
            "podId": POD_ID,
            "podScopedKeyPresent": bool(POD_KEY),
            "controllerKeyInjected": "AITK_CONTROLLER_RUNPOD_KEY" in os.environ,
            "softwareContract": {
                "image": os.environ.get("AITK_IMAGE_DIGEST"),
                "baseImage": os.environ.get("AITK_BASE_IMAGE_DIGEST"),
                "python": platform.python_version(),
                "pytorch": torch.__version__,
                "cuda": torch.version.cuda,
                "comfyUiCommit": os.environ.get("COMFYUI_COMMIT"),
                "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
            },
        }
    )


async def delete(target: str) -> int:
    async with aiohttp.ClientSession() as session:
        async with session.delete(
            f"https://rest.runpod.io/v1/pods/{target}",
            headers={"Authorization": f"Bearer {POD_KEY}", "Accept": "application/json"},
            timeout=aiohttp.ClientTimeout(total=30),
        ) as response:
            await response.read()
            return response.status


async def cross_delete(request: web.Request) -> web.Response:
    if not authorized(request):
        raise web.HTTPUnauthorized()
    if not TARGET or TARGET == POD_ID:
        raise web.HTTPBadRequest()
    return web.json_response({"status": await delete(TARGET)})


async def self_delete(request: web.Request) -> web.Response:
    if not authorized(request):
        raise web.HTTPUnauthorized()

    async def later():
        await asyncio.sleep(1)
        await delete(POD_ID)

    asyncio.create_task(later())
    return web.json_response({"accepted": True}, status=202)


app = web.Application()
app.router.add_get("/proof", proof)
app.router.add_post("/cross-delete", cross_delete)
app.router.add_post("/self-delete", self_delete)

if __name__ == "__main__":
    web.run_app(app, host="0.0.0.0", port=8188, access_log=None)
