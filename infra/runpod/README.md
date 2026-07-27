# RunPod bootstrap

This document covers persistent-network-volume Serverless training. The
isolated, zero-volume interactive ComfyUI Pod integration is documented in
[`RUNPOD_COMFYUI_WORKSPACES.md`](../../RUNPOD_COMFYUI_WORKSPACES.md). Do not
reuse the training template, endpoint, S3 credentials, or network volume for
ComfyUI.

RunPod resources are provisioned with the official REST API through
`remote/runpod/provision.py`. The utility is idempotent by name, refuses
configuration drift, and is plan-only until `--apply` is supplied.

Terraform is intentionally not used here yet. The official `runpod/runpod`
provider v1.0.9 failed `terraform providers schema -json` under Terraform
1.14.3 because its `runpod_endpoint_workers` data source has an invalid
schema. There is also an open provider issue about endpoint updates corrupting
state. Re-evaluate the provider before replacing this REST bootstrap:

- [RunPod Terraform provider](https://registry.terraform.io/providers/runpod/runpod/latest)
- [Endpoint update issue](https://github.com/runpod/terraform-provider-runpod/issues/34)

## Prerequisites

1. Choose one of the worker packaging modes below. Both pin an immutable base
   image. The bootstrap mode additionally pins and verifies one exact public
   Git commit at worker startup.
2. In the RunPod console, create a secret named `aitk_hf_read` containing a
   read-only Hugging Face token. The template stores only the RunPod secret
   reference.
3. Choose one network-volume datacenter that currently offers an H100. The
   endpoint and volume must use the same datacenter.
4. Set a newly-created RunPod API key in the current shell. Never put it on a
   command line or in a `.tfvars` file.

```powershell
$runpodSecret = Read-Host -AsSecureString 'RunPod API key'
$env:RUNPOD_API_KEY = [System.Net.NetworkCredential]::new('', $runpodSecret).Password
```

## Plan, then apply

Replace the datacenter and image digest with the chosen values:

```powershell
python remote/runpod/provision.py `
  --datacenter-id EU-RO-1 `
  --worker-image ghcr.io/OWNER/ai-toolkit-runpod@sha256:DIGEST

python remote/runpod/provision.py `
  --apply `
  --output .runpod-provision.json `
  --datacenter-id EU-RO-1 `
  --worker-image ghcr.io/OWNER/ai-toolkit-runpod@sha256:DIGEST
```

To avoid republishing Ostris's large base image, use its immutable digest and
bootstrap this fork from an exact public commit. The worker verifies the
fetched SHA before installing the pinned `runpod` dependency and starting:

```powershell
python remote/runpod/provision.py `
  --datacenter-id EU-RO-1 `
  --worker-image docker.io/ostris/aitoolkit@sha256:f14841b070159cd2bd43af466b5cc9594b11560d5703d0993cc33ba7100ef270 `
  --source-repository https://github.com/QuantGeekDev/ai-toolkit.git `
  --source-commit 287ab41f4024ab367b15b037878e0fc917391b7e `
  --max-concurrent-jobs 3
```

Add `--apply --output .runpod-provision.json` after reviewing the plan. This
mode adds roughly 15 seconds to a cold start in a local smoke test and avoids
uploading an approximately 11 GB duplicate image. RunPod still has to pull the
official base image when a host does not already cache it.

The output contains no credentials. Copy the returned `aiToolkitSettings`
values into **AI Toolkit > Settings > Remote GPU**, then set these process
environment variables before starting the UI:

```text
AI_TOOLKIT_RUNPOD_ENABLED=1
RUNPOD_API_KEY=...
RUNPOD_S3_ACCESS_ID=...
RUNPOD_S3_SECRET=...
```

RunPod S3 credentials are separate from the RunPod API key and are generated
from **Settings > S3 API Keys** in the RunPod console. They are intentionally
not handled by the bootstrap utility.

The created endpoint has `workersMin=0`, `workersMax` equal to
`--max-concurrent-jobs` (one to three), an idle timeout of five seconds, one
strict H100 GPU per worker, and the network volume attached. This avoids idle
GPU billing; the network volume itself continues to incur storage charges.

If registry authorization is not ready yet, `build_worker.ps1 -BuildOnly`
builds and tags the exact Linux/AMD64 worker locally without attempting a
push. Run `docker push <tag>` after authorization, then record the registry's
immutable digest; a local image ID is not a valid endpoint identity.

Official API references:

- [Create network volume](https://docs.runpod.io/api-reference/network-volumes/POST/networkvolumes)
- [Create template](https://docs.runpod.io/api-reference/templates/POST/templates)
- [Create endpoint](https://docs.runpod.io/api-reference/endpoints/POST/endpoints)
