# Ephemeral RunPod H100 workspaces for Krea 2 Turbo BF16 checkpoint comparison

- **Date:** 2026-07-26
- **Status:** Implementation-ready plan
- **Primary repository:** `C:\Users\Usuario\Documents\ai-toolkit`
- **Runtime model:** Krea 2 Turbo, unquantized BF16 only
- **Default export:** Every saved checkpoint plus a No LoRA baseline
- **Default lifetime:** Two hours maximum, with termination after 60 minutes of inactivity
**Persistence:** No RunPod network volume and no S3 staging in the initial release

## 1. Outcome

Add a production-safe action to an AI Toolkit Krea 2 training job that creates a temporary, authenticated ComfyUI workspace on a Secure Cloud RunPod H100. The workspace must:

1. Use the unquantized `krea2_turbo_bf16.safetensors` inference model, never Krea 2 Raw or a quantized Turbo model.
2. Make **All checkpoints + No LoRA** the default workflow, while retaining the existing single-checkpoint option.
3. Preserve the current in-workflow 9:16/16:9 selector and the proven local comparison semantics.
4. Copy the selected LoRA checkpoints and generated workflow directly from the AI Toolkit host to ephemeral Pod storage.
5. Expose ComfyUI through an authenticated HTTPS proxy without exposing RunPod, AWS, Hugging Face, or SSH secrets to the browser.
6. Terminate after 60 minutes with no user or ComfyUI queue activity, even if the AI Toolkit controller is unavailable.
7. Enforce a separately selected absolute lifetime of 1, 2, 4, or 8 hours, with two hours as the default.
8. Terminate rather than stop the Pod so that the workspace files are deleted under RunPod's storage contract.
9. Reconcile ambiguous provider operations and controller restarts without creating duplicate billable Pods.
10. Provide actionable progress, cost, failure, recovery, and termination state in the existing job UI.

The first release will support one active temporary ComfyUI workspace for the whole AI Toolkit deployment. This is a deliberate cost and concurrency guardrail for a locally hosted, network-accessible controller. The data model and provider interface should not prevent a later configurable workspace pool.

## 2. Decisions and non-negotiable requirements

### 2.1 Krea 2 model contract

“Full precision” means the published, unquantized BF16 ComfyUI model, not an FP32 reconstruction:

| Role | Required file | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Diffusion model | `diffusion_models/krea2_turbo_bf16.safetensors` | 26,283,332,608 | `78bbf8f4165eda19cea3cb06c78089221932a39e2eed8af9da741f942c47ffb3` |
| Text encoder | `text_encoders/qwen3vl_4b_bf16.safetensors` | 8,875,719,384 | `36f3ff447ef59201722e8f9ce6020c9819fdcfba6aa2608c4e09b1c0ce114e34` |
| VAE | `vae/qwen_image_vae.safetensors` | 253,806,246 | `a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f` |

The three files total 35,412,858,238 bytes, approximately 32.98 GiB. Pin the Comfy-Org repository revision initially to `952f49d49653cb42e7d6cf7cbfad74738073ec7d`, and verify both byte length and SHA-256 before readiness. A future model upgrade must be an explicit manifest change, image rebuild, and acceptance run; `main` must never be used as an executable runtime version.

Forbidden files and values include:

- `krea2_raw_bf16.safetensors`
- every Krea 2 Raw variant
- `krea2_turbo_int8_convrot.safetensors`
- every FP8, MXFP8, NVFP4, or other quantized Turbo variant
- a workflow that chooses its inference model from `job_config.model.name_or_path`

This deliberately decouples training and inference. Krea recommends training LoRAs on Raw and applying them to Turbo: [Krea 2 official repository](https://github.com/krea-ai/krea-2#readme). The Comfy-ready files and their placement are documented by [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2), with the exact hashes visible on the individual [Turbo BF16](https://huggingface.co/Comfy-Org/Krea-2/blob/main/diffusion_models/krea2_turbo_bf16.safetensors), [Qwen BF16](https://huggingface.co/Comfy-Org/Krea-2/blob/main/text_encoders/qwen3vl_4b_bf16.safetensors), and [VAE](https://huggingface.co/Comfy-Org/Krea-2/blob/main/vae/qwen_image_vae.safetensors) file pages.

### 2.2 Workflow contract

The cloud workflow must retain the already working local behavior:

- Shared Turbo BF16 base model, BF16 text encoder, VAE, prompt, negative prompt, latent, aspect ratio, and seed.
- A No LoRA baseline branch first.
- One branch for every stable saved checkpoint, in the same deterministic order as the UI list.
- LoRA strength `1.0` by default.
- AuraFlow shift `3.16`.
- Eight steps, CFG `1`, Euler sampler, simple scheduler, denoise `1`.
- A fixed seed across every comparison branch.
- Core `ResolutionSelector`, defaulting to `9:16 (Portrait Widescreen)`, `0.56` megapixels, multiple `16`, and retaining `16:9 (Widescreen)` as an in-workflow choice.
- Save paths isolated below `output/ai-toolkit/<safe-job-name>/<workspace-id>/...`.

The current local ComfyUI reports version `0.28.0`, frontend `1.45.21`, commit `4800e78518ebb1f2a9443ea5418edbff6c3935f9`, and provides `ResolutionSelector` as the core module `comfy_extras.nodes_resolution`. The remote image should pin that known-good commit initially. No aspect-ratio custom node is required.

### 2.3 Ephemeral storage contract

Initial release:

- Secure Cloud only.
- On-demand, non-interruptible H100 only.
- One GPU.
- No `networkVolumeId`.
- `volumeInGb` must be zero or omitted.
- A dynamically sized container disk, minimum 100 GB, contains the model cache, LoRAs, workflows, and outputs.
- The Pod must never be stopped, reset, or edited. It is either running or terminated.
- The controller and remote watchdog use only the delete/terminate operation.

RunPod documents container disk as temporary and lost on stop/restart, while network volumes persist independently. Terminating a Pod permanently deletes data not stored in a network volume: [storage options](https://docs.runpod.io/pods/storage/types) and [Pod management](https://docs.runpod.io/pods/manage-pods).

Container disks are not encrypted at rest according to the same storage documentation. The release must therefore record this residual risk, use Secure Cloud only, minimize lifetime, prohibit unrelated data, and enforce authenticated access. Before implementation closes, Ticket EPH-01 will also probe whether the current Pod creation API can request an encrypted Pod-local volume while preserving automatic deletion. If and only if this is supported, verified, and does not attach a network volume, an encrypted local volume may replace container-only workspace storage. The strict deletion and no-network-volume requirements take priority over this optional hardening.

### 2.4 Transfer contract

Use resumable SFTP directly from the AI Toolkit host to the Pod. Do not stage checkpoints in the existing immutable AWS archive, a RunPod network volume, a public URL, or a browser upload.

- Expose `22/tcp` only for a locked-down `internal-sftp` account with no shell, forwarding, agent, or PTY.
- Expose `8188/http` for the authenticated workspace proxy.
- Upload into `/workspace/aitk/incoming/<workspace-id>/`, never directly into ComfyUI's live model directories.
- Write each item as `<name>.partial`, resume from a validated remote byte offset, verify SHA-256 remotely, then atomically rename.
- Upload `workspace-manifest.json` last and create a `COMMITTED` marker only after all files verify.
- The remote bootstrap installs only committed manifest entries using safe, relative POSIX paths.
- Pin and verify the ephemeral SSH host key fingerprint obtained through the authenticated HTTPS control endpoint before SFTP authentication.

The official open-source [RunPod ComfyUI worker](https://github.com/runpod-workers/worker-comfyui) uses a pinned container pattern and enables SSH through a `PUBLIC_KEY` with port 22 exposed. We adopt the useful image/SSH pattern, but use an interactive Pod rather than its serverless API and restrict SSH to SFTP.

S3 is intentionally not part of the initial critical path. The `echoflicks` profile authenticates locally, but the current archive design is versioned and immutable, which is inappropriate for temporary transfer. A future transfer adapter may add a dedicated non-versioned, lifecycle-managed staging bucket, but launch must fail closed rather than silently leave checkpoints in persistent object storage.

### 2.5 Lifecycle contract

Two independent termination mechanisms are required:

1. **Hard maximum:** the RunPod create request sets the provider-side `terminateAfter` timestamp to creation time plus 1, 2, 4, or 8 hours. The official `runpodctl` exposes `--terminate-after` and its open-source implementation sends `TerminateAfter` in the GPU Pod GraphQL input: [RunPod CLI reference](https://docs.runpod.io/runpodctl/reference/runpodctl-pod) and [runpodctl create source](https://github.com/runpod/runpodctl/blob/2e2df89e1fcb6a16632017a14385552005913732/cmd/pod/create.go).
2. **Inactivity:** a watchdog inside the Pod observes authenticated browser activity and the local ComfyUI queue. When the workspace has been ready and idle for 60 minutes, it enters a two-minute termination grace period and then deletes its own exact `RUNPOD_POD_ID` using the Pod-scoped `RUNPOD_API_KEY` automatically injected by RunPod.

RunPod documents both system environment variables and the Pod-scoped API key: [template environment variables](https://docs.runpod.io/pods/templates/manage-templates) and [runpodctl overview](https://docs.runpod.io/runpodctl/overview). A live capability test must prove that the scoped key can delete only the current Pod. The controller API key must never be passed into the Pod.

Idle means all of the following are true:

- The workspace reached `ready`; startup and model download time do not count as idle.
- ComfyUI `/queue` reports no running and no pending prompt.
- No prompt has just completed.
- No authenticated user input event has been observed for 60 minutes.
- The workspace is not in its bounded final-output synchronization grace period.

Merely leaving a background tab open does not count as activity. Pointer, keyboard, wheel, touch, prompt submission, tab becoming visible, queue start, queue progress, and queue completion do count. A running or pending generation always suppresses idle deletion. The absolute maximum still wins and may terminate an active generation; the UI must warn about this.

This follows the robust principle used by SkyPilot's remote `autodown`: idle teardown runs on the remote machine and considers active work rather than depending on the user's laptop: [SkyPilot autostop/autodown](https://docs.skypilot.co/en/stable/reference/auto-stop.html).

## 3. Current-system findings

The following repository facts shape the implementation:

- `ui/src/server/comfyuiExport.ts` currently combines workflow construction, local ComfyUI installation validation, checkpoint copying, and workflow writing. Cloud support requires separating construction from delivery.
- `baseModelFile()` currently chooses Raw or Turbo from the training config. Cloud construction must always choose the Turbo BF16 constant.
- Workflow LoRA names currently use platform-native `path.join`; a workflow constructed on Windows can contain backslashes that are wrong for Linux. Workflow model paths must use `path.posix.join` independently of local filesystem paths.
- `listKrea2Checkpoints()` discovers top-level `.safetensors` files but does not parse a safetensors header, hash content, reject symlinks/reparse points, or create an immutable staging snapshot.
- `ComfyUIExportButton.tsx` already defaults to comparison mode and exposes single-checkpoint mode. It should retain that selection UI while adding Local and Temporary H100 destinations.
- `/api/jobs/[jobID]/comfyui` assumes the configured local ComfyUI root must exist even to list/export. Cloud inspection must not depend on `D:\ComfyUI-Krea2` being available or running.
- `ui/cron/remote/runpodClient.ts` has good retry/redaction behavior for Serverless requests but no Pod lifecycle API. Pod orchestration should share a low-level authenticated request helper without conflating Serverless executions with workspaces.
- `RemoteExecution` is training-specific. A new `ComfyWorkspace` aggregate is required.
- `ui/cron/worker.ts` awaits reconciliation and queue processing in one one-second loop. Multi-minute provisioning or transfer work must not block training queues, so workspaces need a dedicated supervised worker process.
- The existing remote training integration already uses immutable image digests, RunPod secret references, controller-only credentials, ambiguous-submission handling, durable reconciliation, and redaction. Reuse those policies.
- The current H200 scripts under `C:\Users\Usuario\Documents\krea2-loras\runpod` prove ComfyUI commit `4800e785...` and the BF16 Krea/Qwen/VAE stack on RunPod, but they install extra LTX/WAN nodes and use persistent `/workspace`. The new image must be minimal and ephemeral.
- AI Toolkit APIs are protected only when `AI_TOOLKIT_AUTH` is configured. Billable workspace creation must be disabled when this deployment authentication is missing or uses a known placeholder.
- The process is Windows-hosted. SFTP implementation and tests must work without Bash, WSL, or an interactive OpenSSH prompt.

## 4. Proposed architecture

```text
Authenticated AI Toolkit browser
        |
        | POST workspace request (comparison default)
        v
AI Toolkit API + SQLite
        |
        | durable requested state
        v
Dedicated Comfy workspace worker
        |
        +-- snapshot and hash LoRAs + workflow manifest
        +-- inspect H100 availability and price ceiling
        +-- create Secure Cloud Pod with terminateAfter
        +-- reconcile ambiguous create by deterministic Pod name
        +-- verify Pod identity, H100, ports, image digest, no volume
        +-- SFTP resumable manifest contents
        +-- poll authenticated bootstrap/control status
        v
Ephemeral RunPod H100 Pod
        |
        +-- pinned ComfyUI image and minimal dependencies
        +-- download pinned Turbo BF16 model set and verify hashes
        +-- restricted SFTP staging area
        +-- install committed workflow + LoRAs atomically
        +-- ComfyUI on loopback:8189
        +-- auth/WebSocket proxy on public:8188
        +-- local activity/queue watchdog
        +-- self-delete after 60 idle minutes
        v
Authenticated temporary ComfyUI session
        |
        +-- No LoRA + all checkpoints in one queue action
        +-- optional local output mirroring
        `-- manual terminate or automatic deletion
```

### 4.1 Process boundaries

- The existing `WORKER` process remains responsible for training queues and `RemoteExecution`.
- A new `COMFY` process runs `dist/cron/comfyWorkspaceWorker.js` and owns workspace lifecycle mutations.
- The Next.js API creates requests and reads state but never performs a long provider, hashing, or transfer operation in a request.
- The Pod sidecar owns remote bootstrap status, proxy authentication, activity, queue observation, and self-termination.
- ComfyUI listens on `127.0.0.1:8189`; only the sidecar listens publicly on `0.0.0.0:8188`.

### 4.2 Provider choice and cost controls

- Requested GPU order: `NVIDIA H100 80GB HBM3`, then `NVIDIA H100 PCIe`, optionally `NVIDIA H100 NVL` if enabled. Never fall back outside H100.
- `cloudType=SECURE`, `interruptible=false`, `gpuCount=1`.
- Default maximum hourly price: configurable, initially `$3.50`; provider availability and returned cost must both be below the ceiling.
- Default one active workspace globally.
- Capacity wait is not billable. Wait up to 15 minutes, show a cancellable `waiting_for_capacity` state, and do not silently select Community Cloud.
- Maximum cost shown to the user is `returnedHourlyRate × selectedHours`; note that startup/model-download time is included.
- If the returned Pod is not an H100, has a network volume, exceeds the price ceiling, lacks the required public ports, or runs the wrong image digest, request immediate termination and never upload a checkpoint.

### 4.3 Workspace disk sizing

Calculate before provisioning:

```text
required bytes =
    pinned model bytes
  + immutable staged checkpoint bytes
  + 2 GiB workflow/log/bootstrap allowance
  + max(20 GiB, checkpoint bytes, configured output allowance)
```

Round up to the next 10 GB, enforce a 100 GB minimum and a configurable 200 GB maximum. If the request exceeds the maximum, fail before provisioning with the exact required size and suggested remediation (fewer checkpoints or a higher operator cap). Never provision first and discover insufficient disk later.

### 4.4 Portable workspace manifest

Create a deterministic JSON manifest with canonical key ordering:

```json
{
  "schemaVersion": 1,
  "workspaceId": "uuid",
  "job": {
    "id": "uuid",
    "name": "display name",
    "currentStep": 2000,
    "triggerWord": "token"
  },
  "export": {
    "mode": "comparison",
    "workflowFile": "AI Toolkit - job - all-checkpoints.json",
    "workflowSha256": "...",
    "checkpointCount": 8,
    "includesNoLora": true
  },
  "model": {
    "id": "krea2-turbo-bf16-comfy-v1",
    "repository": "Comfy-Org/Krea-2",
    "revision": "952f49d49653cb42e7d6cf7cbfad74738073ec7d",
    "manifestSha256": "..."
  },
  "files": [
    {
      "role": "lora",
      "sourceName": "job_000001000.safetensors",
      "remotePath": "loras/ai-toolkit/job/job_000001000.safetensors",
      "bytes": 123,
      "sha256": "...",
      "step": 1000,
      "isFinal": false
    }
  ],
  "createdAt": "2026-07-26T00:00:00.000Z"
}
```

The manifest must contain no absolute local paths, API keys, passwords, tokens, private keys, presigned URLs, or AWS configuration.

### 4.5 Database model

Add `ComfyWorkspace` and `ComfyWorkspaceArtifact`; do not overload `RemoteExecution`.

Suggested `ComfyWorkspace` fields:

| Field | Purpose |
| --- | --- |
| `id` | Stable workspace UUID and orchestration identity |
| `job_id` / relation | Owning training job; deletion restricted while workspace is active |
| `request_key` | Unique client idempotency key |
| `managed_pod_name` | Unique deterministic name `aitk-comfy-<workspace-id>` |
| `provider_pod_id` | Unique nullable RunPod Pod ID |
| `active_lease_key` | Unique nullable singleton key while nonterminal |
| `state`, `phase` | Durable state machine |
| `export_mode` | `comparison` or `single` |
| `selected_checkpoint` | Nullable exact checkpoint name |
| `workflow_name` | Generated user workflow name |
| `checkpoint_count` | Count captured in immutable manifest |
| `manifest_sha256` | Canonical workspace identity |
| `model_manifest_sha256` | Pinned Turbo stack identity |
| `requested_gpu`, `actual_gpu` | Request and worker attestation |
| `container_disk_gb` | Planned/provider disk size |
| `hourly_rate`, `estimated_max_cost` | Cost shown and audited |
| `max_runtime_minutes`, `idle_timeout_minutes` | Requested policies |
| `provider_started_at`, `ready_at`, `expires_at` | Lifecycle timestamps |
| `last_user_activity_at`, `last_queue_activity_at` | Sanitized remote status mirrors |
| `bytes_planned`, `bytes_transferred` | Transfer progress |
| `public_url` | Non-secret RunPod proxy URL |
| `ssh_host`, `ssh_port`, `ssh_host_fingerprint` | Transfer endpoint identity |
| `output_sync_state`, `output_sync_error` | Best-effort result preservation |
| `termination_reason`, `termination_requested_at`, `terminated_at` | Teardown audit |
| `error_code`, `error_message` | Sanitized actionable failure |
| `lease_owner`, `lease_expires_at` | Crash-safe worker ownership |
| `created_at`, `updated_at` | Audit timestamps |

Suggested artifact fields:

- `id`, `workspace_id`, `role`
- `display_name`, `local_path`, `remote_relative_path`
- `byte_length`, `sha256`
- `transferred_bytes`, `transfer_state`, `attempts`
- `source_size`, `source_mtime_ms`
- `error_message`, `created_at`, `updated_at`

Absolute local paths remain server-side only and must never be serialized in browser responses. Store no workspace access token; derive control and session-signing keys from a required controller master secret using HKDF and the workspace ID.

### 4.6 State machine

```text
requested
  -> preparing_bundle
  -> waiting_for_capacity
  -> provisioning
  -> provisioning_unknown       # ambiguous provider response; never blind retry
  -> booting
  -> transferring
  -> validating
  -> ready <-> busy
  -> idle_grace
  -> syncing_outputs
  -> terminating
  -> terminated | expired | failed
```

Terminal states are `terminated`, `expired`, and `failed_confirmed_absent`. A workspace with an unknown or possibly running Pod is not terminal and must retain the global lease.

Rules:

- API requests only create `requested`, set cancellation/termination intent, or request output sync.
- Only the dedicated worker advances infrastructure states.
- A `DELETE` response failure leaves the workspace in `terminating`; the worker polls until RunPod reports `TERMINATED` or `404`.
- A provider create timeout becomes `provisioning_unknown`. Reconciliation searches by the exact managed Pod name and workspace marker for at least ten minutes; it must not submit a second create automatically.
- The global active lease is released only after provider absence is confirmed.
- A stopped or exited managed Pod is terminated, never restarted, because its ephemeral contract is already broken.
- A Pod that self-terminates for idle or hard expiry is detected as absent and mapped to `expired` with the most recent remote reason.

### 4.7 Authenticated browser session

RunPod's HTTP proxy is public and has a 100-second intermediary timeout, so authentication is mandatory and long operations must be asynchronous: [RunPod exposed ports](https://docs.runpod.io/pods/configuration/expose-ports).

Use this flow:

1. The authenticated AI Toolkit UI calls `POST /api/comfyui/workspaces/<id>/open`.
2. The API derives a workspace signing key from `AI_TOOLKIT_COMFY_MASTER_SECRET`, signs a five-minute one-time access assertion, and returns `https://<pod>-8188.proxy.runpod.net/#access_token=<assertion>`.
3. URL fragments are not sent to RunPod or Cloudflare. A minimal public landing page reads the fragment, clears it from browser history, and posts it over HTTPS to `/aitk/session`.
4. The sidecar validates expiry, workspace ID, nonce, and signature; consumes the nonce; then sets a random session cookie with `Secure`, `HttpOnly`, and `SameSite=Strict`.
5. All ComfyUI HTTP and WebSocket routes require the cookie. `/aitk/control/*` instead requires a distinct controller bearer token and never accepts the browser cookie.
6. Invalid login attempts are rate limited and logged without token material.

The proxy must support WebSocket upgrade frames for `/ws`, streaming downloads, range requests, and uploads. It must not enable ComfyUI Manager, a terminal, Jupyter, arbitrary shell access, or unauthenticated ComfyUI APIs.

ComfyUI officially exposes `/prompt`, `/queue`, `/history`, `/system_stats`, `/object_info`, and `/ws`, which are sufficient for readiness and activity detection: [ComfyUI routes](https://docs.comfy.org/development/comfyui-server/comms_routes) and [WebSocket messages](https://docs.comfy.org/development/comfyui-server/comms_messages).

### 4.8 Output handling

Generated images are the only remote artifacts worth preserving; source LoRAs and workflow definitions already exist locally.

- Default UI checkbox: **Copy generated images back to this job before automatic termination**.
- While ready/busy, the controller may mirror stable new files every 30 seconds to `output/<job>/comfyui-workspaces/<workspace-id>/`.
- Only regular files under the workspace-specific ComfyUI output prefix are eligible. Reject symlinks, traversal, special files, and a configurable per-workspace output byte cap.
- Download to `.partial`, verify remote size and optional SHA-256, then atomically rename locally.
- At idle grace or user-requested graceful termination, perform one bounded final sync of at most two minutes.
- A failed output sync never extends the hard RunPod deadline and never prevents eventual deletion. Surface the warning and files already copied.
- Provide **Terminate immediately** for security/cost emergencies and **Sync outputs then terminate** as the normal action.

## 5. API surface

All routes inherit existing AI Toolkit middleware authentication. Workspace creation must additionally fail with `503` when `AI_TOOLKIT_AUTH` or `AI_TOOLKIT_COMFY_MASTER_SECRET` is missing.

### Job-scoped routes

- `GET /api/jobs/<jobID>/comfyui`
  - Return checkpoints independently of local ComfyUI availability.
  - Return separate `local` and `temporaryH100` capability objects.
  - Include current active workspace summary, configured duration choices, idle policy, price ceiling, and any configuration errors.

- `POST /api/jobs/<jobID>/comfyui`
  - Preserve current local export behavior only.

- `POST /api/jobs/<jobID>/comfyui/workspaces`
  - Body: `{ requestKey, mode: "comparison" | "single", checkpoint?, maxHours: 1 | 2 | 4 | 8, preserveOutputs: boolean }`.
  - Validate job/checkpoint synchronously, create durable `requested`, return `202` with workspace ID.
  - Same `requestKey` returns the same workspace. A different job while the singleton lease is occupied returns `409` with the existing workspace summary.

### Workspace routes

- `GET /api/comfyui/workspaces/<workspaceID>` returns sanitized state and progress.
- `POST /api/comfyui/workspaces/<workspaceID>/open` returns a five-minute fragment-based access URL only when ready/busy.
- `POST /api/comfyui/workspaces/<workspaceID>/sync-outputs` records sync intent.
- `DELETE /api/comfyui/workspaces/<workspaceID>?mode=graceful|immediate` records termination intent and returns `202`.
- `GET /api/comfyui/workspaces/<workspaceID>/events` is optional; polling every three seconds is acceptable for MVP and avoids adding an event transport.

Never return provider environment variables, SSH locations before authentication, local paths, manifest source paths, controller tokens, session signing keys, RunPod API keys, or the SFTP private key.

## 6. Configuration

### Required secrets, environment only

```text
RUNPOD_API_KEY=...
AI_TOOLKIT_AUTH=strong-network-password
AI_TOOLKIT_COMFY_MASTER_SECRET=base64-encoded-32-or-more-random-bytes
RUNPOD_COMFY_SSH_PRIVATE_KEY_PATH=C:\secure\ai-toolkit-comfy-ed25519
```

The public half may be a normal setting:

```text
RUNPOD_COMFY_SSH_PUBLIC_KEY=ssh-ed25519 ...
```

The RunPod template references the existing RunPod secret name `aitk_hf_read` as `{{ RUNPOD_SECRET_aitk_hf_read }}`. The actual Hugging Face token is not sent by AI Toolkit.

### Non-secret settings

```text
AI_TOOLKIT_RUNPOD_COMFY_ENABLED=1
RUNPOD_COMFY_IMAGE_DIGEST=ghcr.io/...@sha256:...
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
RUNPOD_COMFY_LOCAL_STAGING_DIRECTORY=<absolute path>
```

Environment values override saved Settings rows. Validation rejects mutable image tags, non-H100 GPU IDs, a rate below zero, timeouts outside the allowlist, relative paths, missing/unreadable keys, and `MAX_ACTIVE` values other than `1` in the first release.

## 7. Detailed implementation tickets

### EPH-01 — Live provider capability gate and frozen contracts

**Goal:** Prove every provider assumption before application code can create a billable workspace.

**Dependencies:** None.

**Work:**

- Add a read-only `remote/runpod/comfyui/preflight.py` or TypeScript preflight command.
- Introspect or contract-test the current GPU Pod creation input used by `runpodctl` for `terminateAfter`, exact H100 IDs, template/image selection, ports, price ceiling, and zero network volume.
- Verify whether an encrypted Pod-local volume can be requested programmatically. Adopt it only if create, restart behavior, delete behavior, and API reporting are all proven; otherwise retain container-only storage and document the residual risk.
- Launch one bounded disposable H100 smoke Pod with a 15-minute provider hard termination.
- Prove `RUNPOD_POD_ID` and a Pod-scoped `RUNPOD_API_KEY` exist without injecting the controller key.
- From inside that Pod, prove the scoped key can delete its own Pod. Also prove it cannot list/create unrelated account resources if the provider exposes those restrictions.
- Verify Secure Cloud returns a public IP and TCP mapping for `22/tcp` plus the `8188` proxy URL.
- Record the exact base image digest, CUDA, Python, PyTorch, and ComfyUI compatibility chosen for EPH-04.
- Terminate in a `finally` block and confirm provider absence.

**Failure policy:** If self-deletion or provider-side `terminateAfter` cannot be demonstrated, do not ship automatic workspace creation. No local `sleep`, browser timer, or controller-only timeout is an adequate substitute for both safeguards.

**Tests/acceptance:** Command exits nonzero on any unmet invariant, emits no credentials, and leaves no Pod or storage resource behind. Save a sanitized JSON report suitable for attaching to the implementation PR.

### EPH-02 — Workspace configuration and secret boundaries

**Goal:** Add independent ComfyUI Pod configuration without weakening the existing Serverless training settings.

**Dependencies:** EPH-01.

**Likely files:**

- `ui/cron/comfy/settings.ts`
- `ui/src/helpers/settingsSecrets.ts`
- `ui/src/app/settings/page.tsx`
- `ui/src/app/api/settings/route.ts`
- `remote/runpod/comfyui/comfyui.env.example`

**Work:**

- Introduce `RunPodComfyConfig`, its keys, defaults, parser, validator, and public secret-status shape.
- Keep `RUNPOD_API_KEY`, controller master secret, and private SSH key path out of the Settings database and all browser payloads.
- Require a strong `AI_TOOLKIT_AUTH`; reject missing or known placeholder values when the billable feature is enabled.
- Validate the SSH private/public key pair without logging either key.
- Validate immutable OCI digest syntax and the Turbo model manifest digest.
- Add a **Test temporary H100 configuration** action that performs only read-only provider, filesystem, secret-reference, and network checks.
- Keep Serverless training enabled/disabled independently from temporary ComfyUI.

**Unit tests:** Precedence, numeric bounds, allowlist parsing, missing authentication, wrong key pair, mutable image tag, redaction, and no collision with `RUNPOD_SETTING_KEYS`.

**Acceptance:** Settings page shows only configured/not configured for secrets and explains that temporary workspaces create billable Pods.

### EPH-03 — Prisma workspace aggregate, leases, and migration safety

**Goal:** Persist lifecycle, transfer progress, and crash-safe ownership separately from training runs.

**Dependencies:** EPH-02.

**Likely files:**

- `ui/prisma/schema.prisma`
- `ui/cron/comfy/state.ts`
- database backup/migration documentation

**Work:**

- Add `ComfyWorkspace` and `ComfyWorkspaceArtifact` with the fields and indexes in Section 4.5.
- Use `onDelete: Restrict` for active workspace/job relationships; update job deletion to return `409` until the workspace is confirmed absent.
- Enforce unique `request_key`, `provider_pod_id`, `managed_pod_name`, and nullable `active_lease_key`.
- Implement an explicit transition table; illegal transitions fail loudly and are unit-tested.
- Implement an atomic worker lease with expiry and renewal so a restarted or accidentally duplicated workspace worker cannot race provider mutations.
- Release the singleton active lease only on confirmed provider absence.
- Back up `aitk_db.db` before production `prisma db push`; document rollback.

**Unit tests:** All legal/illegal transitions, two-worker lease contention, expired lease takeover, duplicate request key, singleton conflict, job deletion protection, and terminal lease release.

**Acceptance:** Restarting either server process preserves and resumes an active workspace record without duplicate creation.

### EPH-04 — Minimal pinned ComfyUI Turbo BF16 image

**Goal:** Produce an immutable, minimal Linux/AMD64 image that can bootstrap exactly the required inference stack.

**Dependencies:** EPH-01.

**Likely files:**

- `remote/runpod/comfyui/Dockerfile`
- `remote/runpod/comfyui/requirements.lock`
- `remote/runpod/comfyui/model-manifest.json`
- `remote/runpod/comfyui/entrypoint.py`
- `remote/runpod/comfyui/download_models.py`
- `remote/runpod/comfyui/build_image.ps1`

**Work:**

- Pin the base image by digest and pin ComfyUI commit `4800e785...` initially.
- Install only ComfyUI and dependencies needed by the generated core-node workflow. Do not install Manager, LTX, WAN, outpaint, prompt-enhancement, or unrelated nodes.
- Pin Python dependencies and record their lock digest in OCI labels.
- Include software, sidecar, extension, and scripts in the image; do not include model weights or LoRAs.
- At startup, download only the three manifest files from the pinned Hugging Face revision using `huggingface_hub`/`hf_xet`, with resumable downloads and bounded retry.
- Verify byte lengths and SHA-256 before atomic placement. A mismatch deletes only the bad partial file and retries once; repeated mismatch is terminal.
- Write structured bootstrap status atomically for the sidecar.
- Start ComfyUI only after model verification, then validate `/system_stats`, required `/object_info` node classes, exact model visibility, and H100 device identity.
- Bind ComfyUI to loopback port 8189. Disable Manager and CORS.
- Run as a non-root service user where compatible; use a tiny root init only for SFTP/permissions, then drop privileges.
- Build only from a clean committed worktree and print the pushed immutable digest.

**Unit/container tests:** Manifest parser, hash mismatch, interrupted download resume, no forbidden filenames, non-H100 rejection, required core nodes, signal handling, and clean child-process shutdown.

**Acceptance:** A live H100 image cold-start reaches model-verified status and generates one Turbo BF16 image without a network volume.

### EPH-05 — Remote auth proxy, ComfyUI activity extension, and idle watchdog

**Goal:** Secure the public RunPod proxy and make idle termination independent of the local controller.

**Dependencies:** EPH-01, EPH-04.

**Likely files:**

- `remote/runpod/comfyui/sidecar/app.py`
- `remote/runpod/comfyui/sidecar/auth.py`
- `remote/runpod/comfyui/sidecar/proxy.py`
- `remote/runpod/comfyui/sidecar/watchdog.py`
- `remote/runpod/comfyui/custom_nodes/aitk_workspace/web/activity.js`

**Work:**

- Implement fragment-token session exchange, one-time nonce use, secure cookie issuance, expiry, logout, and rate limiting.
- Reverse-proxy ComfyUI HTTP, range, upload/download, and WebSocket traffic; never buffer a generation until completion.
- Add authenticated controller endpoints for status, SSH fingerprint, install/commit, output catalog, bounded graceful termination, and health.
- Return a minimal progress page before ComfyUI is ready.
- Implement the activity extension with throttled pointer, touch, wheel, keyboard, visibility, prompt, queue, progress, completion, and error events.
- Poll local `/queue` defensively. Malformed or unavailable queue status must not be interpreted as idle.
- Start idle timing at `ready`, not Pod boot.
- At 60 idle minutes, enter a two-minute grace, expose that state to the controller, and self-delete the exact `RUNPOD_POD_ID` with the scoped key.
- Retry delete with jitter; treat `404` as success; never call stop. Do not log the Pod-scoped key.
- The absolute `expiresAt` is displayed and cannot be extended by browser activity.
- Add clock-injected tests so no test sleeps for real minutes.

**Security tests:** Missing/expired/replayed assertion, cookie tampering, wrong workspace, CSRF-like cross-origin POST, brute-force rate limit, unauthenticated `/ws`, controller-token/browser-token separation, header smuggling, and log redaction.

**Idle tests:** Background tab only, active editing, pending queue, long-running queue, queue completion reset, Comfy failure, controller absence, grace expiry, and hard deadline precedence.

**Acceptance:** With the AI Toolkit controller stopped, a two-minute test-configured idle workspace deletes itself; a busy queue does not. Production config remains fixed at 60 minutes unless an explicit test-only override is enabled.

### EPH-06 — Portable Turbo-only workflow and immutable bundle builder

**Goal:** Refactor the current local export so workflow construction is transport-neutral and cloud-safe.

**Dependencies:** EPH-03.

**Likely files:**

- `ui/src/server/comfyuiExport.ts`
- `ui/src/server/comfyuiBundle.ts`
- `ui/src/server/comfyui/modelContract.ts`
- `ui/src/server/comfyui/krea2-lora-workflow.json`

**Work:**

- Separate checkpoint discovery, workflow construction, bundle staging, local delivery, and remote delivery.
- Introduce an explicit `KREA2_TURBO_BF16_COMFY_V1` model contract.
- Make cloud workflows always Turbo BF16 even when the training job config names Raw.
- Preserve local export behavior unless intentionally migrated; consider making local evaluation Turbo-only too for consistency, but keep that as an explicit reviewed change.
- Use `path.posix.join` for model paths embedded in workflow JSON and native `path` only for host filesystem operations.
- Read safetensors headers under a bounded header-size limit to reject truncated/empty/non-safetensors files without loading tensors into memory. Accept AI Toolkit LoRA and LoKr key layouts.
- Reject symlinks, junctions/reparse points, directories, traversal, reserved names, and files outside the exact job output directory.
- Create an immutable local staging copy for each selected checkpoint. Compare source size/mtime before and after copying; hash the staged bytes; if the source changes, fail the whole request with `CHECKPOINT_STILL_SAVING`.
- Check local staging free space before copying.
- Generate canonical manifest JSON and workflow JSON deterministically.
- Preserve comparison ordering: No LoRA, final, descending saved steps, then stable unknown-step names.
- Do not silently skip a checkpoint. Report the exact unstable/invalid file.
- Deduplicate transfer by SHA only if final remote filenames and all comparison branches remain distinct; otherwise prefer simplicity over hard links.

**Unit tests:** Raw-trained job still produces Turbo; recursive assertion that no forbidden model name appears; exact sampling settings; POSIX LoRA paths on Windows; comparison/single modes; stable ordering; trigger substitution; invalid JSON; changing source; safetensors header variants; symlink/traversal; deterministic hashes; free-space failure; duplicate bytes; and zero checkpoints.

**Acceptance:** A cloud manifest built on Windows installs unchanged on Linux and the workflow opens without missing-node or missing-model warnings.

### EPH-07 — RunPod Pod client and ambiguous-create reconciliation

**Goal:** Add a narrowly scoped, testable provider adapter for Pod lifecycle operations.

**Dependencies:** EPH-01, EPH-02, EPH-03.

**Likely files:**

- `ui/cron/remote/httpClient.ts`
- `ui/cron/comfy/runpodPodClient.ts`
- `ui/cron/comfy/runpodTypes.ts`

**Work:**

- Extract reusable authenticated JSON/retry/redaction behavior from the existing Serverless client without changing its semantics.
- Use the provider operation proven in EPH-01 to create GPU Pods with a deterministic name and `terminateAfter`.
- Use REST list/get/delete for reconciliation where documented.
- Create payload must set Secure Cloud, one H100, non-interruptible, immutable image, calculated container disk, no volume/network volume, `8188/http`, `22/tcp`, HF secret reference, workspace marker, derived control token, SSH public key, idle minutes, and hard expiry.
- Never blindly retry create after a transport timeout. Reconcile by exact name/marker; surface `provisioning_unknown` until resolved.
- Safe reads use bounded exponential backoff with jitter and `Retry-After` support.
- Delete is idempotent: retry transport/5xx, treat 404/TERMINATED as success, and retain state on uncertainty.
- Parse both current and legacy response shapes for GPU identity, cost, public IP, port mappings, image, network volume, and desired status.
- Attest actual GPU contains H100, not merely the requested list.
- Verify returned hourly cost against the configured ceiling and terminate immediately on violation.
- Implement managed-orphan listing by exact prefix plus controller/workspace marker.

**Unit tests:** Exact create payload, forbidden fallback, terminate timestamp, no persistent volume, price ceiling, wrong GPU/image/volume, safe read retry, `Retry-After`, ambiguous create no retry, adoption by name, duplicate matches, delete 404, delete ambiguity, malformed JSON, auth failure, and secret redaction.

**Acceptance:** Replaying reconciliation after killing the controller at every provider boundary produces at most one managed Pod.

### EPH-08 — Restricted resumable SFTP transport

**Goal:** Transfer multi-gigabyte checkpoints reliably without persistent intermediary storage.

**Dependencies:** EPH-04, EPH-06, EPH-07.

**Likely files:**

- `ui/cron/comfy/sftpTransport.ts`
- `remote/runpod/comfyui/configure_sftp.sh`
- Node dependency `ssh2` and typings

**Work:**

- Configure a chrooted/internal-SFTP-only user and `authorized_keys` restrictions.
- Resolve public IP and mapped SSH port from the Pod GET response.
- Fetch the ephemeral SSH host fingerprint over the authenticated HTTPS control channel, then require `ssh2` host verification.
- Transfer at most two files concurrently and expose byte progress.
- Resume only when remote partial size is between zero and expected length. A larger or inconsistent partial is removed and restarted.
- After upload, request remote SHA verification and atomic commit. Never trust byte count alone.
- Reconnect and resume after controller restart using durable artifact rows.
- Bound connection, handshake, inactivity, and per-attempt retry timeouts.
- Treat auth/fingerprint failures as non-retryable security errors and terminate the Pod.
- Clean local staging after remote readiness or terminal failure; add a janitor for abandoned staging older than a safe retention period.

**Unit/integration tests:** Embedded/containerized SFTP server; first upload; midstream disconnect; resume; zero-byte partial; oversized partial; remote hash mismatch; changed local stage; wrong host key; wrong private key; traversal/symlink; Windows path; reconnect; cancellation; and progress persistence.

**Acceptance:** Interrupt a real multi-gigabyte upload, restart the workspace worker, and complete without retransmitting the verified prefix or duplicating the Pod.

### EPH-09 — Dedicated workspace orchestrator and recovery loop

**Goal:** Implement the durable state machine without blocking training reconciliation.

**Dependencies:** EPH-03, EPH-06, EPH-07, EPH-08.

**Likely files:**

- `ui/cron/comfyWorkspaceWorker.ts`
- `ui/cron/comfy/reconcileWorkspaces.ts`
- `ui/cron/comfy/workspaceService.ts`
- `ui/package.json`

**Work:**

- Add a separately supervised `COMFY` process to `dev`, `start`, and build configuration.
- Claim one workspace through the DB lease and advance one idempotent state at a time.
- Snapshot/hash before provisioning to avoid paying for a Pod when input is invalid.
- Wait for capacity with a 15-minute request deadline and cancellable polling.
- Start model bootstrap and checkpoint transfer in parallel after secure Pod identity/ports are available.
- Poll remote structured status; never scrape logs for control decisions.
- Mark ready only after model hashes, H100, Comfy core nodes, committed LoRAs, workflow visibility, auth proxy, and watchdog are all verified.
- Poll ready/busy state and mirror activity/cost timestamps.
- Handle manual graceful/immediate termination, idle grace, hard expiry, stopped/exited Pod, bootstrap failure, transfer failure, and output-sync failure.
- Reconcile all DB-active workspaces at startup before accepting a new singleton lease.
- List managed Pods to find DB-missing orphans. Delete only Pods with the exact managed prefix and matching controller marker; report other similarly named Pods without touching them.
- When a Pod has self-deleted, map its last known remote termination reason and confirm absence.
- A process crash between local state update and external request must be safe on replay.

**Unit tests:** Table-driven crash/replay at every transition, lease loss, cancellation in every pre-ready phase, controller restart while ready, provider outage, remote status outage, Pod stop/restart, self-delete, duplicate managed Pods, unmanaged name collision, and singleton release.

**Acceptance:** Existing local and Serverless training queues continue to run while a workspace hashes/uploads multi-gigabyte files.

### EPH-10 — Workspace API routes and job deletion safety

**Goal:** Expose the orchestrator safely and asynchronously to the authenticated UI.

**Dependencies:** EPH-03, EPH-06, EPH-09.

**Work:**

- Implement the routes in Section 5 with strict body schemas and response DTOs.
- Keep local ComfyUI inspection separate from temporary H100 capability.
- Generate or require a client `requestKey`; make POST idempotent.
- Validate job type/architecture, mode, exact checkpoint membership, duration allowlist, and active singleton.
- Derive short-lived open assertions; never store or return long-lived credentials.
- Return `202` for requested mutations, `409` for active-workspace conflicts, `422` for invalid job/checkpoint/policy, `503` for disabled/misconfigured provider, and `502` only for read-only provider preflight failures.
- Protect job deletion while a workspace may still be billable. A separate terminal-history cleanup action may delete old rows later.
- Sanitize every error boundary.

**Unit tests:** Route auth integration, comparison default when mode omitted, single mode validation, duplicate request, two simultaneous creates, no checkpoints, changing checkpoint, invalid hours, configuration disabled, open-before-ready, expired/replayed open assertion, graceful/immediate delete, and active-job deletion.

**Acceptance:** Closing or refreshing the browser after `202` does not cancel or duplicate the workspace.

### EPH-11 — Job UI and operator experience

**Goal:** Make temporary H100 the clear remote option while preserving local export.

**Dependencies:** EPH-10.

**Likely files:**

- `ui/src/components/ComfyUIExportButton.tsx`
- `ui/src/components/ComfyWorkspacePanel.tsx`
- `ui/src/components/JobActionBar.tsx`

**Work:**

- Change the modal destination choice to **Temporary H100 workspace (recommended)** and **Local ComfyUI**.
- Keep **All checkpoints + No LoRA** selected by default for both destinations.
- Retain the single-checkpoint selector.
- Explain Turbo BF16 inference even for Raw-trained LoRAs.
- Offer maximum duration 1/2/4/8 hours, default 2; display fixed 60-minute idle deletion.
- Show checkpoint count/bytes, calculated disk, selected H100 policy, hourly ceiling, and estimated maximum GPU cost before confirmation.
- Use an explicit billable-action confirmation.
- Display durable phases: preparing, capacity, provisioning, model download, transfer bytes, validation, ready, busy, idle countdown, output sync, terminating, terminated/error.
- Show both absolute expiry and idle countdown; hard expiry always wins.
- Add Open ComfyUI, Sync outputs, Sync then terminate, and Terminate immediately actions as appropriate.
- Explain that LoRAs/workspace data disappear on termination and unsynced outputs are lost.
- Rehydrate an active workspace after page reload and continue polling with backoff when the page is hidden.
- Make errors actionable and preserve provider error codes for support without leaking secrets.

**Component tests:** Default selections, cost math, disabled states, resume after reload, all state renderings, open-link handling, terminate confirmation, local-unavailable/cloud-available, no checkpoints, and accessible labels/focus behavior.

**Acceptance:** A user with no file-explorer access can launch, open, use, observe, and terminate the workspace entirely from the job page.

### EPH-12 — Output mirroring and bounded graceful teardown

**Goal:** Preserve desired generated images without persisting checkpoints remotely.

**Dependencies:** EPH-08, EPH-09, EPH-11.

**Work:**

- Implement remote output catalog with regular-file/path checks and stable-size detection.
- Mirror only the workspace-specific output prefix to the local job output directory.
- Persist per-file progress for resume and atomic local placement.
- Set byte/file limits and surface when limits are reached.
- At idle grace, notify UI/controller, allow a maximum two-minute final sync, then self-delete regardless of sync success.
- Manual graceful termination follows the same bounded path; immediate termination skips it.
- Never upload output to AWS/S3 by default.

**Tests:** Growing output file, duplicate name, partial local file, checksum mismatch, symlink/traversal, output cap, network failure during idle grace, hard expiry during sync, and immediate termination.

**Acceptance:** Generated images already verified locally remain after Pod deletion; no LoRA is copied into an S3 bucket or RunPod network volume.

### EPH-13 — Observability, redaction, and cost safety

**Goal:** Make failures diagnosable without exposing credentials or allowing silent billing.

**Dependencies:** EPH-07 through EPH-12.

**Work:**

- Emit structured logs keyed by workspace ID, job ID, Pod ID, state, phase, attempt, elapsed time, bytes, and sanitized provider code.
- Add metrics/counters for requested, ready, failed, expired, manual termination, orphan cleanup, create ambiguity, startup seconds, transfer throughput, active Pod seconds, and estimated cost.
- Never log request headers, environment maps, fragment assertions, cookies, private keys, scoped keys, HF tokens, or RunPod/AWS keys.
- Redact known bearer/key formats and derived controller tokens in both Node and Python.
- Add a dashboard/status summary to Settings: active workspace, age, rate, expiry, last remote contact, termination state.
- Alert prominently when a Pod remains possibly billable after repeated delete uncertainty; retain the singleton lease and provider console link.
- Add a read-only **Reconcile now** action. A force-forget action is out of scope because it can hide billing.

**Tests:** Secret canaries through every error/log path, delete uncertainty, stale heartbeat, provider 401/429/5xx, and metrics state mapping.

**Acceptance:** A simulated provider outage cannot cause a second Pod or make the UI claim the first Pod is gone.

### EPH-14 — Image/template provisioning and operational tooling

**Goal:** Make infrastructure reproducible without reusing the training network volume or H200 template.

**Dependencies:** EPH-01, EPH-04, EPH-05.

**Likely files:**

- `remote/runpod/comfyui/provision.py`
- `remote/runpod/comfyui/README.md`
- `remote/runpod/comfyui/build_image.ps1`

**Work:**

- Extend the existing plan/apply provisioning style for a private, non-Serverless ComfyUI template.
- Template references immutable image digest, `aitk_hf_read`, ports 8188/22, and no network volume.
- Per-workspace dynamic values remain create-request environment values and are not saved in the reusable template.
- Refuse drift in image, ports, disk policy, startup command, secret reference, or network-volume attachment.
- Emit only non-secret IDs/settings.
- Add commands to build/push, provision, preflight, launch a test Pod, run acceptance, confirm deletion, and rotate keys.
- Do not alter or terminate the existing H200 Pod/template or Serverless training endpoint.

**Tests:** Plan/apply idempotence with mocked API, drift detection, no secrets in output, no network volume, immutable image enforcement, and cleanup after partial provisioning.

**Acceptance:** A fresh operator can reproduce the template and enable the feature using the runbook without clicking through a mutable ad-hoc setup.

### EPH-15 — Automated test suites and CI wiring

**Goal:** Make all non-provider behavior repeatable in CI and keep live GPU tests explicit.

**Dependencies:** All implementation tickets.

**Work:**

- Keep Vitest for Node logic and add `jsdom` plus Testing Library for React components.
- Add Python `unittest` or `pytest` consistently for sidecar/bootstrap/watchdog; choose one and pin it.
- Add a local fake RunPod HTTP/GraphQL server with scripted response sequences.
- Add a containerized SFTP integration fixture.
- Add a fake ComfyUI server implementing `/system_stats`, `/object_info`, `/queue`, `/prompt`, and `/ws` behaviors needed by tests.
- Add Docker image structure tests that assert no model weights, Raw filenames, Manager, controller credentials, or network-volume assumptions are present.
- Add an opt-in live suite guarded by `RUNPOD_LIVE_TEST=1`, a maximum dollar budget, an explicit H100 allowlist, and cleanup in `finally` plus a post-test orphan sweep.
- CI default runs zero billable operations and cannot see production secrets.

**Commands expected at completion:**

```text
cd ui && npm test
cd ui && npm run build
python -m unittest discover remote/runpod/comfyui/tests
python remote/runpod/comfyui/preflight.py
python remote/runpod/comfyui/acceptance.py --live --max-cost <bounded-value>
```

**Acceptance:** Every ticket's unit/integration cases are mapped to an automated test or a named live acceptance case.

### EPH-16 — Documentation, rollout, and live deployment

**Goal:** Deploy safely to `ai-toolkit.andreayalexclub.com` and provide recovery procedures.

**Dependencies:** EPH-01 through EPH-15.

**Work:**

- Add `RUNPOD_COMFY_WORKSPACES.md` covering architecture, data lifecycle, cost, secrets, model pins, build, provisioning, use, and limitations.
- Document capacity unavailable, model download failure, checkpoint mutation, transfer resume, auth lockout, idle deletion, hard expiry, delete uncertainty, orphan reconciliation, output recovery, key rotation, DB restore, and feature disable.
- Back up the SQLite database and current deployment configuration.
- Deploy with feature flag off; run schema update, unit/build checks, and read-only preflight.
- Enable only for an operator account/network, run the bounded acceptance suite, inspect billing and orphan list, then enable the job action.
- Keep a kill switch `AI_TOOLKIT_RUNPOD_COMFY_ENABLED=0` that blocks new requests but continues reconciliation and termination of existing workspaces.
- Rollback must never stop the workspace worker while a Pod may be running; first terminate/confirm absence, then roll back application code.

**Acceptance:** The production URL can launch and use the comparison workflow, and the final post-test RunPod account check shows no managed Pod or persistent storage resource left behind.

## 8. Error taxonomy and remediation

| Code | Condition | Automatic behavior | User/operator action |
| --- | --- | --- | --- |
| `COMFY_DISABLED` | Feature flag/auth/master secret missing | No provisioning | Fix Settings/environment |
| `NO_CHECKPOINTS` | Job has no saved LoRAs | No provisioning | Wait for/save a checkpoint |
| `CHECKPOINT_STILL_SAVING` | Size/mtime changed during snapshot | Delete local partial; no provisioning | Retry after save completes |
| `INVALID_SAFETENSORS` | Header invalid/truncated/empty | No provisioning | Inspect named artifact |
| `LOCAL_STAGING_FULL` | Insufficient local free disk | No provisioning | Free space/reduce selection |
| `WORKSPACE_LIMIT` | Another active workspace owns singleton | Return existing summary; no provisioning | Use/terminate existing workspace |
| `H100_UNAVAILABLE` | No permitted H100 under ceiling | Wait up to 15 minutes; no Pod | Retry later/adjust approved ceiling |
| `POD_CREATE_UNKNOWN` | Create response ambiguous | Never blind retry; reconcile exact name | Wait; operator checks provider if unresolved |
| `POD_IDENTITY_FAILED` | Wrong GPU/image/volume/price/ports | Terminate before upload | Correct provider/template config |
| `MODEL_DOWNLOAD_FAILED` | Pinned HF revision unavailable/network failure | Resume/retry bounded; then terminate | Retry later/check secret/upstream |
| `MODEL_HASH_MISMATCH` | Downloaded model violates manifest | Delete bad partial, retry once, terminate | Investigate upstream/manifest; never bypass |
| `SFTP_HOST_MISMATCH` | TCP host key differs from HTTPS attestation | Abort and terminate | Investigate network/provider |
| `TRANSFER_INTERRUPTED` | SFTP/network interruption | Resume partial with bounded attempts | Wait/retry workspace if exhausted |
| `TRANSFER_HASH_MISMATCH` | Remote LoRA differs | Remove remote partial and retry once | Re-snapshot source if repeated |
| `COMFY_START_FAILED` | Required nodes/models/GPU not ready | Capture sanitized status and terminate | Inspect image compatibility |
| `AUTH_BOOTSTRAP_FAILED` | Sidecar assertion/cookie setup fails | Workspace remains locked; bounded retry | Regenerate open link; inspect clock/secret |
| `REMOTE_STATUS_UNAVAILABLE` | Sidecar or provider reads fail | Do not infer idle/absence; hard TTL remains | Wait; inspect provider |
| `OUTPUT_SYNC_PARTIAL` | Some outputs could not be mirrored | Preserve completed files; do not exceed teardown bound | Download earlier/retry while active |
| `POD_DELETE_UNKNOWN` | Delete response ambiguous | Keep state/lease and poll; alert | Verify in RunPod console if prolonged |
| `MANAGED_ORPHAN_FOUND` | Marked Pod lacks DB-active row | Terminate exact managed orphan | Audit cause |
| `UNMANAGED_NAME_COLLISION` | Similar Pod lacks controller marker | Do not touch; warn | Operator reviews manually |

All public messages must be concise and sanitized. Detailed internal errors may include workspace/Pod IDs and provider status, but never credentials or arbitrary provider response bodies.

## 9. Unit and integration test matrix

### Workflow and bundle

- Raw-trained job produces Turbo BF16 workflow.
- Turbo-trained job produces the same Turbo model contract.
- Forbidden Raw/quantized strings are absent recursively.
- Comparison is default and contains baseline plus every checkpoint exactly once.
- Single mode contains only the selected checkpoint.
- All branches share seed/prompt/negative/latent/sampling settings.
- 9:16 defaults and 16:9 remains available through core `ResolutionSelector`.
- Linux model paths use `/` even when built on Windows.
- Staging detects a concurrent training save and remains atomic.
- Safetensors/LoRA/LoKr headers, unknown metadata, large bounded headers, truncation, symlinks, and traversal.
- Manifest canonicalization and digest determinism.

### Provider and state

- H100 priority/fallback only within H100.
- Secure/on-demand/one-GPU/no-volume create payload.
- Provider `terminateAfter` exact timestamp and hard-duration validation.
- Price ceiling before and after create.
- Ambiguous create adoption; never a blind second POST.
- Provider 401, 404, 408, 429, and 5xx mapping.
- Delete idempotency and uncertainty.
- Controller crash/replay at every state transition.
- Worker lease contention/expiry and singleton retention.
- Managed orphan versus unmanaged collision.

### Transfer and remote bootstrap

- Resume from valid partial offset.
- Reject invalid offset, host key, auth key, path, symlink, and hash.
- Exact model revision/size/hash.
- Model retry/resume and corrupted partial deletion.
- Atomic install only after `COMMITTED`.
- H100 attestation and required core nodes.
- No Raw/quantized model file downloaded.
- ComfyUI inaccessible directly on loopback port.

### Proxy and lifecycle

- One-time fragment assertion; token never reaches request URL.
- Secure session cookie and WebSocket authentication.
- Replay/expiry/wrong workspace/rate limiting.
- Queue running/pending prevents idle.
- Actual user input resets idle; passive background tab does not.
- Idle starts at readiness and self-delete survives controller loss.
- Absolute hard expiry cannot be extended.
- Graceful output sync is bounded; immediate delete bypasses it.
- Pod-scoped and controller tokens never appear in logs.

### UI/API

- Cloud available while local `D:` ComfyUI is down.
- Comparison and Temporary H100 defaults.
- Exact duration allowlist and cost display.
- Idempotent launch and global conflict handling.
- Durable progress after modal/page reload.
- Open only when ready, fragment URL handling, terminate confirmations.
- Active workspace blocks job deletion.
- Feature-disabled and provider-failure messages.

## 10. Live acceptance tests

Every live test must register the created workspace/Pod immediately, run under a strict cost budget, and terminate in `finally`. A final account-wide managed-prefix sweep is mandatory.

### AT-01 — Read-only production preflight

- Production authentication and controller master secret are configured.
- Image is immutable and template has no network volume.
- H100 offer exists below the configured ceiling or the UI correctly reports capacity unavailable.
- SFTP key pair and local staging path validate.

### AT-02 — Default comparison from a Raw-trained job

- Launch without changing modal defaults.
- Manifest contains every stable checkpoint and a No LoRA baseline.
- Remote workflow uses only Krea 2 Turbo BF16, BF16 Qwen, and the VAE.
- No Raw/INT8/FP8/NVFP4 model is present anywhere in the workspace.

### AT-03 — Authenticated ComfyUI readiness

- Unauthenticated `/`, `/prompt`, `/queue`, and `/ws` cannot reach ComfyUI.
- AI Toolkit Open action exchanges a one-time fragment assertion and loads ComfyUI.
- Replaying the assertion fails; the established cookie continues until expiry/termination.

### AT-04 — Comparison execution

- Open the generated workflow.
- Change between 9:16 and 16:9 in the workflow.
- Queue once and generate one result for No LoRA and every checkpoint.
- Branch metadata shows identical shared prompt, seed, steps, CFG, sampler, scheduler, shift, and latent dimensions.
- Actual GPU attestation is H100.

### AT-05 — Single-checkpoint execution

- Launch single mode for a non-final checkpoint.
- Only that LoRA is transferred and referenced.
- Generation succeeds with Turbo BF16.

### AT-06 — Controller restart during transfer

- Interrupt a multi-gigabyte SFTP transfer.
- Restart the dedicated workspace worker and then the whole AI Toolkit service.
- Transfer resumes from verified partial bytes.
- Only one Pod exists and the final workflow is correct.

### AT-07 — Capacity and price failure

- Use a test ceiling below current price or an unavailable H100 constraint.
- No non-H100 or Community Pod is created.
- State is actionable and no workspace data is staged remotely.

### AT-08 — Idle self-termination without controller

- Use a test-only two-minute idle policy and a 15-minute hard maximum.
- Reach ready, stop the local controller, leave queue empty, and provide no input.
- Pod enters grace and deletes itself.
- Provider GET becomes 404/TERMINATED and no volume/network volume remains.

### AT-09 — Active queue suppresses idle

- Use a workflow that runs longer than the test idle interval.
- Stop the controller.
- Confirm the Pod remains while queue is active, then deletes after completion plus idle/grace.

### AT-10 — Provider hard maximum

- Keep an authenticated browser active and use a test 15-minute maximum.
- Stop the controller.
- Provider terminates the Pod at the hard deadline despite activity.

### AT-11 — Manual graceful and immediate teardown

- Graceful action mirrors stable output, deletes Pod, and preserves the local image.
- Immediate action deletes without waiting.
- Neither path calls stop.

### AT-12 — Checkpoint mutation before provisioning

- Modify a fixture checkpoint during snapshot.
- Request fails before a Pod is created and names the unstable checkpoint.

### AT-13 — Bootstrap/hash failure

- Use a deliberately wrong test model hash.
- Workspace never becomes ready, no ComfyUI route is exposed, and the Pod terminates.

### AT-14 — Delete uncertainty and recovery

- Inject a timeout after a delete request.
- UI remains `terminating/unknown`, singleton remains locked, and polling eventually confirms absence without creating another Pod.

### AT-15 — Managed orphan cleanup

- Create a test marked Pod, remove only its fixture DB record, and restart reconciliation.
- Exact managed orphan is terminated; a similarly named unmarked Pod is reported but untouched.

### AT-16 — Secret leakage audit

- Seed canary values for every secret class.
- Inspect browser responses, SQLite text fields, bundle/manifest, logs, process arguments, Pod environment returned to UI, workflow JSON, and local outputs.
- No canary appears outside its authorized process boundary.

### AT-17 — Production end-to-end

- From `https://ai-toolkit.andreayalexclub.com`, launch the default comparison from a real Krea 2 job.
- Open the temporary RunPod URL, run both aspect ratios, sync outputs, and terminate.
- Confirm local ComfyUI may remain down throughout.
- Confirm RunPod has no `aitk-comfy-*` Pod or new persistent storage after the test.

## 11. Rollout gates

### Gate 0 — Provider safety

- EPH-01 proves server-side hard termination and Pod-scoped self-delete.
- Exact H100 and price policies are known.
- No existing H200 Pod or training endpoint is changed.

### Gate 1 — Offline correctness

- All Node/Python/component/container tests pass.
- `npm run build` passes.
- No forbidden model strings or secret canaries exist in image/bundle outputs.

### Gate 2 — Bounded disposable Pod

- Image boots on H100, exact models verify, auth works, SFTP works, and one image generates.
- Pod self-deletes and hard deadline is observed.

### Gate 3 — Recovery and cost

- Transfer/controller restart, ambiguous create/delete, capacity failure, and orphan tests pass.
- Account sweep shows no leaked resources.

### Gate 4 — Production canary

- Feature enabled for operator use.
- Real all-checkpoint workflow succeeds from the public AI Toolkit site while local ComfyUI is down.
- Billing duration and estimated cost match within provider rounding.

### Gate 5 — General availability on the local network

- Runbooks and kill switch verified.
- Alerts/status expose any possibly billable Pod.
- Default remains comparison + No LoRA, Turbo BF16, two-hour maximum, 60-minute idle termination, one active workspace.

## 12. Explicit non-goals for the first release

- Krea 2 Raw inference.
- Any quantized Krea 2 inference model.
- H200, B200, A100, RTX, Community Cloud, or spot fallback.
- More than one active workspace.
- Persistent RunPod network volumes.
- Uploading checkpoints to the existing AWS archive.
- S3 as an automatic silent fallback.
- Keeping a stopped/restartable workspace.
- Arbitrary user-selected ComfyUI images, models, or custom nodes.
- Jupyter, shell, ComfyUI Manager, or general-purpose Pod access.
- Guaranteeing unsynced generated outputs after immediate/hard termination.
- Deleting or reconfiguring the currently running H200 Pod.

## 13. Definition of done

The feature is done only when all of the following are true:

- A user can launch the default all-checkpoint-plus-baseline comparison from the AI Toolkit job page without local ComfyUI running.
- The remote graph uses only the exact unquantized Krea 2 Turbo BF16 stack and proven comparison settings.
- The generated graph exposes 9:16 and 16:9 inside ComfyUI.
- Checkpoints transfer directly and resumably without a persistent intermediary.
- The public ComfyUI endpoint is authenticated for HTTP and WebSocket traffic.
- Provider hard expiry and remote 60-minute idle self-deletion both work with the local controller stopped.
- Manual termination and every automatic path delete rather than stop.
- Ambiguous create/delete and controller restarts cannot create duplicate billing or falsely release the singleton lease.
- Unit, component, integration, container, and all applicable live acceptance tests pass.
- Production deployment, rollback, orphan cleanup, secret rotation, and cost-response runbooks exist.
- The final live account sweep confirms no managed Pod or persistent workspace storage remains.

## 14. Reference index

- [Krea 2 official repository — train on Raw, infer on Turbo, recommended Turbo settings](https://github.com/krea-ai/krea-2#readme)
- [Comfy-Org Krea 2 ComfyUI model layout](https://huggingface.co/Comfy-Org/Krea-2)
- [RunPod create Pod API](https://docs.runpod.io/api-reference/pods/POST/pods)
- [RunPod find Pod API — public IP and TCP port mappings](https://docs.runpod.io/api-reference/pods/GET/pods/podId)
- [RunPod Pod lifecycle and termination](https://docs.runpod.io/pods/manage-pods)
- [RunPod storage semantics](https://docs.runpod.io/pods/storage/types)
- [RunPod exposed-port security and proxy timeout](https://docs.runpod.io/pods/configuration/expose-ports)
- [RunPod CLI Pod create/terminate-after](https://docs.runpod.io/runpodctl/reference/runpodctl-pod)
- [RunPod Pod system variables and secret references](https://docs.runpod.io/pods/templates/manage-templates)
- [RunPod open-source ComfyUI worker](https://github.com/runpod-workers/worker-comfyui)
- [ComfyUI server routes](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [ComfyUI WebSocket messages](https://docs.comfy.org/development/comfyui-server/comms_messages)
- [SkyPilot remote autostop/autodown](https://docs.skypilot.co/en/stable/reference/auto-stop.html)
