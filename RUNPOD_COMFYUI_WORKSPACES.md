# Ephemeral RunPod Krea 2 Turbo ComfyUI workspaces

AI Toolkit can launch one temporary, authenticated RunPod Secure Cloud H100
workspace for a Krea 2 training job. The remote workflow always uses the exact
unquantized Krea 2 Turbo BF16 model contract in
`remote/runpod/comfyui/model-manifest.json`; training may still use Krea 2 Raw.
This feature is isolated from RunPod Serverless training and does not reuse its
endpoint, network volume, S3 staging, or worker.

## Safety contract

- Secure Cloud only, one explicitly allowed H100, on-demand.
- Immutable image digest; pinned ComfyUI commit and Hugging Face revision.
- Container disk only: `volumeInGb=0` and no network volume ID.
- Provider `terminateAfter` on every create request (1/2/4/8 hours).
- Independent remote 60-minute idle watchdog plus a two-minute deletion grace.
- Pods are only deleted. They are never stopped, restarted, or reset.
- One global active workspace until provider absence is confirmed.
- Public port 8188 is an authenticated HTTP/WebSocket proxy; ComfyUI listens
  only on loopback port 8189.
- Port 22 is fingerprint-pinned, key-only, chrooted internal SFTP. Shells,
  forwarding, Jupyter, terminals, and ComfyUI Manager are absent.
- Checkpoints are snapshotted, structurally validated as safetensors, hashed,
  resumably uploaded, and installed only after a committed manifest verifies.
- Generated images are copied to
  `output/<job>/comfyui-workspaces/<workspace-id>/`. LoRAs and models are not
  remotely archived.

Container disks are not documented as encrypted at rest. The implementation
keeps container-only storage because an encrypted Pod-local,
zero-network-volume contract has not been verified. Minimize workspace
lifetime and send no unrelated data.

## Required environment

Secrets are environment-only:

```text
RUNPOD_API_KEY=...
AI_TOOLKIT_AUTH=<strong non-placeholder value, 16+ characters>
AI_TOOLKIT_COMFY_MASTER_SECRET=<base64 encoding of 32+ random bytes>
RUNPOD_COMFY_SSH_PRIVATE_KEY_PATH=C:\secure\ai-toolkit-comfy-ed25519
```

Non-secret settings can be process environment or saved in Settings:

```text
AI_TOOLKIT_RUNPOD_COMFY_ENABLED=1
RUNPOD_COMFY_IMAGE_DIGEST=ghcr.io/OWNER/IMAGE@sha256:...
RUNPOD_COMFY_SSH_PUBLIC_KEY=ssh-ed25519 ...
RUNPOD_COMFY_GPU_IDS=NVIDIA H100 80GB HBM3,NVIDIA H100 PCIe
RUNPOD_COMFY_MAX_HOURLY_RATE=3.50
RUNPOD_COMFY_DEFAULT_MAX_HOURS=2
RUNPOD_COMFY_ALLOWED_MAX_HOURS=1,2,4,8
RUNPOD_COMFY_IDLE_MINUTES=60
RUNPOD_COMFY_MIN_CONTAINER_DISK_GB=100
RUNPOD_COMFY_MAX_CONTAINER_DISK_GB=200
RUNPOD_COMFY_OUTPUT_ALLOWANCE_GB=20
RUNPOD_COMFY_CAPACITY_WAIT_MINUTES=15
RUNPOD_COMFY_MAX_ACTIVE=1
RUNPOD_COMFY_HF_SECRET_NAME=aitk_hf_read
RUNPOD_COMFY_REGISTRY_AUTH_ID=<RunPod credential ID for a private image>
RUNPOD_COMFY_LOCAL_STAGING_DIRECTORY=C:\secure\ai-toolkit-comfy-staging
RUNPOD_COMFY_CAPABILITY_REPORT=C:\path\to\capability-contract.json
```

Generate the controller secret and SFTP key outside the repository:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)

ssh-keygen -t ed25519 -f C:\secure\ai-toolkit-comfy-ed25519 -C aitk-comfy-sftp
```

Create a RunPod secret named `aitk_hf_read` with a read-only Hugging Face
token. AI Toolkit passes only the RunPod secret reference.

For a private image, create a RunPod container-registry authentication whose
password is a registry token with pull-only package access, then set
`RUNPOD_COMFY_REGISTRY_AUTH_ID` to the returned non-secret ID. The registry
username/token are stored only by RunPod and are never sent to a Pod or saved
in AI Toolkit.

## Build, preflight, and provisioning

Build the pinned Linux/AMD64 image:

```powershell
remote\runpod\comfyui\build_image.ps1 `
  -ImageTag ghcr.io/OWNER/ai-toolkit-comfy:COMMIT `
  -BuildOnly
```

After registry authentication, omit `-BuildOnly`. Record the returned
`image@sha256:...`; mutable tags and local image IDs are rejected.

Run the read-only model/provider contract gate:

```powershell
python remote/runpod/comfyui/preflight.py `
  --output remote/runpod/comfyui/capability-contract.json
```

Before enabling the feature, run the bounded, billable live gate. It creates
only random `aitk-comfy-capability-*` H100 Pods, tests scoped self-deletion and
cross-Pod denial using disposable Pods, waits for provider hard expiry, and
cleans exact test identities in `finally`:

```powershell
$env:RUNPOD_LIVE_TEST='1'
python remote/runpod/comfyui/acceptance.py `
  --live `
  --image ghcr.io/OWNER/IMAGE@sha256:DIGEST `
  --registry-auth-id $env:RUNPOD_COMFY_REGISTRY_AUTH_ID `
  --hard-deadline-minutes 15 `
  --max-cost 2.00 `
  --output remote/runpod/comfyui/capability-contract.json
Remove-Item Env:RUNPOD_LIVE_TEST
```

Automatic creation must stay disabled unless the report has
`selfDeleteConfirmed=true` and `providerTerminateAfterConfirmed=true`.

The optional reusable template is plan-only by default:

```powershell
python remote/runpod/comfyui/provision.py --image ghcr.io/OWNER/IMAGE@sha256:DIGEST --registry-auth-id $env:RUNPOD_COMFY_REGISTRY_AUTH_ID
python remote/runpod/comfyui/provision.py --apply --image ghcr.io/OWNER/IMAGE@sha256:DIGEST --registry-auth-id $env:RUNPOD_COMFY_REGISTRY_AUTH_ID
```

It refuses drift and has no persistent or network volume. Dynamic workspace
identity, derived auth keys, expiry, and SFTP key remain per-Pod.

## Operator runbook

The durable lifecycle is:

```text
requested -> preparing_bundle -> waiting_for_capacity -> provisioning
-> booting -> transferring -> validating -> ready <-> busy
-> idle_grace/syncing_outputs -> terminating -> terminated/expired
```

`provisioning_unknown` means the create response was ambiguous. The worker
reconciles by exact random name and workspace marker and never blindly creates
a second Pod. `terminating` plus an occupied global lease means absence is not
confirmed; inspect RunPod before changing the database.

Common recovery:

- `COMFY_DISABLED`: fix every Settings validation error, restart all three UI
  processes, then enable.
- `INVALID_SAFETENSORS` / `CHECKPOINT_CHANGED`: wait for saving to finish and
  inspect the named file. Never bypass validation.
- `CAPACITY_TIMEOUT`: no allowed Secure H100 appeared within 15 minutes.
  Waiting is not billable.
- `POD_IDENTITY_FAILED`: immediate deletion was requested before checkpoint
  upload. Inspect GPU, image, ports, volume, and price settings.
- `MODEL_HASH_MISMATCH` / `MODEL_DOWNLOAD_FAILED`: investigate the pinned
  Hugging Face revision or rebuild; never switch to `main`.
- `SFTP_AUTH_OR_HOST_FAILED`: check/rotate the dedicated key and investigate
  fingerprint mismatch. Never disable host verification.
- `REMOTE_STATUS_UNAVAILABLE`: do not infer idle or absence. Provider hard
  expiry remains authoritative.
- `POD_DELETE_UNKNOWN`: retain the lease, locate/delete the exact Pod in
  RunPod, and wait for reconciliation to confirm 404.
- Output sync warnings never extend hard expiry; verified local files remain.

To disable new work, set `AI_TOOLKIT_RUNPOD_COMFY_ENABLED=0`, but keep the
workspace worker running until every managed Pod is confirmed absent. For
rollback, terminate/synchronize active workspaces, confirm there are no
`aitk-comfy-*` Pods, back up SQLite and staging, then roll back code. Never
roll back the worker while a Pod may still be billable.

## Deletion and incident response

Provider deletion destroys the container disk and its checkpoints, models,
workflows, sessions, and unsynchronized images. Local immutable staging is
removed after confirmed absence. Verified images remain in the job folder.

If a URL, cookie, key, or controller secret may be exposed:

1. Request **Terminate immediately** and verify absence.
2. Disable new creation.
3. Rotate the master secret, app auth, dedicated SFTP key pair, and RunPod key
   as applicable.
4. Redeploy environment configuration; do not preserve sessions/assertions.
5. Review structured logs by workspace/Pod ID. Logs omit headers, cookies,
   assertions, environment maps, and credentials.
