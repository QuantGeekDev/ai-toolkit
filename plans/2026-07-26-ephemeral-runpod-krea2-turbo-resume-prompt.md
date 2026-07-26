# Resume prompt — implement ephemeral RunPod Krea 2 Turbo ComfyUI workspaces

You are resuming a production implementation task on a Windows host. Do not stop at analysis or produce another plan: read the existing implementation plan completely, validate its external assumptions against current official provider documentation, then implement, test, provision, deploy, and commit the feature in full. Keep working through safe, in-scope problems until the definition of done and applicable acceptance tests are satisfied. If a live provider capability or credential is genuinely unavailable, complete all independent work first and report the exact remaining blocker with evidence; never silently weaken a security, deletion, model, or cost invariant.

## Primary objective

Add a button and lifecycle UI to the locally hosted AI Toolkit website that creates a temporary authenticated ComfyUI workspace on a RunPod Secure Cloud H100 for evaluating Krea 2 LoRAs. A user who only has website access must be able to launch the workspace, open ComfyUI, compare the No LoRA baseline with every saved checkpoint in one workflow by default, optionally choose one checkpoint instead, switch between 9:16 and 16:9 inside the workflow, generate images, preserve selected outputs locally, and terminate the workspace without access to the server's file explorer.

The existing local ComfyUI must be allowed to remain down throughout the remote flow.

Public applications:

- AI Toolkit new-job page: `https://ai-toolkit.andreayalexclub.com/jobs/new`
- Example training job: `https://ai-toolkit.andreayalexclub.com/jobs/7aa5f9ea-5881-42cc-b32d-2a03e38eb1d9`
- Existing local ComfyUI site: `https://comfyui.andreayalexclub.com/`

## Read this first

The authoritative, detailed implementation plan is:

`C:\Users\Usuario\Documents\ai-toolkit\plans\2026-07-26-ephemeral-runpod-krea2-turbo-comfyui-workspaces.md`

Read that file from beginning to end before editing. Implement all tickets EPH-01 through EPH-16, including their unit, integration, component, container, live acceptance, rollout, rollback, cleanup, observability, and documentation requirements. Treat its definition of done and rollout gates as requirements, not suggestions.

Relevant project documentation, all with full paths:

- `C:\Users\Usuario\Documents\ai-toolkit\KREA2_COMFYUI_EXPORT.md`
- `C:\Users\Usuario\Documents\ai-toolkit\RUNPOD_REMOTE_TRAINING.md`
- `C:\Users\Usuario\Documents\ai-toolkit\plans\2026-07-25-runpod-remote-training-implementation-plan.md`
- `C:\Users\Usuario\Documents\ai-toolkit\infra\runpod\README.md`
- `C:\Users\Usuario\Documents\ai-toolkit\testing\RUNPOD_ACCEPTANCE.md`
- `C:\Users\Usuario\Documents\ai-toolkit\infra\aws-archive\README.md`
- `C:\Users\Usuario\Documents\ai-toolkit\README.md`
- `C:\Users\Usuario\Documents\ai-toolkit\ui\README.md`
- `C:\Users\Usuario\Documents\ai-toolkit\docker-compose.yml`

The AWS archive documentation is relevant for understanding the current training handoff, but the initial ComfyUI workspace implementation must not use that archive or S3 for checkpoint staging.

## Repository and current handoff state

Primary source repository:

`C:\Users\Usuario\Documents\ai-toolkit`

At the time this handoff prompt was written:

- Current branch: `codex/gemini-cloud-captioning`
- Current HEAD: `2930388 Support three concurrent RunPod training jobs`
- The detailed 2026-07-26 implementation plan is untracked.
- No implementation for the ephemeral ComfyUI workspace has been made yet.

Immediately run `git status`, inspect recent commits, and check for `AGENTS.md` before acting because the state may have changed. Preserve every existing/user change. Do not reset, clean, overwrite, or discard unrelated work. If still appropriate, create a dedicated `codex/ephemeral-runpod-comfyui` branch from the current HEAD before implementation. Add the plan and this handoff prompt to version control with the implementation. Use logical commits and finish with a clean, tested working tree; do not commit secrets, databases, generated models, LoRAs, output images, build caches, or temporary bundles.

## Non-negotiable product and model contract

1. Inference uses Krea 2 Turbo unquantized BF16 only. In this project, "full precision" means the published BF16 ComfyUI model, not an FP32 reconstruction.
2. Never use Krea 2 Raw for inference, even when the LoRA training job was trained against Raw. Krea's intended flow is Raw training and Turbo inference.
3. Never use INT8, FP8, MXFP8, NVFP4, or another quantized inference model.
4. Pin and verify the exact model revision, byte lengths, and SHA-256 hashes recorded in the implementation plan. The required files are:
   - `diffusion_models/krea2_turbo_bf16.safetensors`
   - `text_encoders/qwen3vl_4b_bf16.safetensors`
   - `vae/qwen_image_vae.safetensors`
5. Initially pin ComfyUI to the locally proven commit `4800e78518ebb1f2a9443ea5418edbff6c3935f9`, subject to EPH-01 compatibility verification.
6. The default export and launch mode is all stable checkpoints plus a No LoRA baseline. Retain an explicit single-checkpoint option.
7. Preserve the working comparison graph settings: shared fixed seed and inputs, AuraFlow shift `3.16`, eight steps, CFG `1`, Euler sampler, simple scheduler, denoise `1`, LoRA strength `1.0`, core `ResolutionSelector`, 9:16 default, and 16:9 as an in-workflow choice.
8. Workflow paths generated on Windows must use POSIX separators when consumed by Linux.

The proven local comparison workflow is:

`C:\Users\Usuario\Documents\krea2-loras\runpod\workflows\HERBERT_KREA2_TURBO_CHECKPOINT_COMPARE.json`

The local Krea 2 ComfyUI installation is:

`D:\ComfyUI-Krea2`

AI Toolkit training runs are under:

`D:\AI-Toolkit-Runs`

Use the local workflow and installation only as read-only compatibility references. The new remote feature must not require them to be running and must not copy their unnecessary custom nodes into the remote image.

Existing RunPod H200 reference scripts, which must not be treated as the new ephemeral architecture:

- `C:\Users\Usuario\Documents\krea2-loras\runpod\setup-comfy.sh`
- `C:\Users\Usuario\Documents\krea2-loras\runpod\pre_start.sh`
- `C:\Users\Usuario\Documents\krea2-loras\runpod\start-comfy.sh`
- `C:\Users\Usuario\Documents\krea2-loras\runpod\upload-loras.ps1`

They are useful for proven versions and model placement, but they install unrelated nodes and use persistent storage. Do not modify, restart, terminate, or repurpose the current H200 Pod, its template, or the existing RunPod Serverless training endpoint/network volume.

## Required temporary workspace architecture

- RunPod Secure Cloud only.
- One on-demand, non-interruptible H100 only; permitted fallback is between explicitly approved H100 variants, never H200/A100/B200/RTX/Community Cloud/spot.
- One active temporary workspace globally for the first release.
- No RunPod network volume and no S3/AWS staging in the initial release. The local AWS CLI profile `echoflicks` exists, but do not use it for this transfer path.
- Direct resumable SFTP from the AI Toolkit host into Pod-local ephemeral storage, with SSH host-key verification, `.partial` files, persisted offsets, remote SHA-256 verification, and atomic commit.
- Dynamically sized Pod container disk within the limits in the plan. Check local and remote capacity before a billable launch.
- The Pod must be terminated/deleted, never stopped, so LoRAs and workspace data disappear.
- User-selectable absolute maximum of 1, 2, 4, or 8 hours; default two hours.
- Provider-enforced `terminateAfter` must be set at creation.
- A watchdog inside the Pod must self-delete after 60 minutes without authenticated browser or ComfyUI queue activity, even if the local AI Toolkit controller is offline.
- A running or pending ComfyUI queue suppresses idle deletion. Passive presence of a hidden/background tab does not.
- The public ComfyUI proxy must authenticate HTTP and WebSocket traffic. No secret may be put in a query string, browser payload, workflow, bundle, database field intended for the browser, or log.
- ComfyUI listens only on loopback behind the authenticated sidecar. Do not expose Manager, shell, Jupyter, or general-purpose Pod access.
- Output mirroring is bounded and best-effort. It must never delay provider hard expiry or prevent eventual deletion.

EPH-01 is a mandatory live capability gate. Prove provider-side hard termination and that RunPod's automatically injected Pod-scoped key can delete only its own Pod. If either cannot be proven, do not substitute a browser timer, local `sleep`, or controller-only cleanup and do not enable the billable production action. Every disposable live test must have a provider hard maximum, cleanup in `finally`, and a final managed-Pod/account sweep.

## Existing code seams to inspect and refactor

ComfyUI export and UI:

- `C:\Users\Usuario\Documents\ai-toolkit\ui\src\server\comfyuiExport.ts`
- `C:\Users\Usuario\Documents\ai-toolkit\ui\src\server\comfyuiExport.test.ts`
- `C:\Users\Usuario\Documents\ai-toolkit\ui\src\server\comfyui\krea2-lora-workflow.json`
- `C:\Users\Usuario\Documents\ai-toolkit\ui\src\components\ComfyUIExportButton.tsx`
- `C:\Users\Usuario\Documents\ai-toolkit\ui\src\app\api\jobs\[jobID]\comfyui\route.ts`

RunPod and worker infrastructure:

- `C:\Users\Usuario\Documents\ai-toolkit\ui\cron\remote\runpodClient.ts`
- `C:\Users\Usuario\Documents\ai-toolkit\ui\cron\remote\runpodClient.test.ts`
- `C:\Users\Usuario\Documents\ai-toolkit\ui\cron\remote\settings.ts`
- `C:\Users\Usuario\Documents\ai-toolkit\ui\cron\actions\processQueue.ts`
- `C:\Users\Usuario\Documents\ai-toolkit\ui\cron\worker.ts`
- `C:\Users\Usuario\Documents\ai-toolkit\remote\runpod\provision.py`
- `C:\Users\Usuario\Documents\ai-toolkit\remote\runpod\handler.py`
- `C:\Users\Usuario\Documents\ai-toolkit\remote\runpod\worker.py`
- `C:\Users\Usuario\Documents\ai-toolkit\remote\runpod\build_worker.ps1`

Settings, persistence, and deployment:

- `C:\Users\Usuario\Documents\ai-toolkit\ui\prisma\schema.prisma`
- `C:\Users\Usuario\Documents\ai-toolkit\ui\src\server\settings.ts`
- `C:\Users\Usuario\Documents\ai-toolkit\ui\src\helpers\settingsSecrets.ts`
- `C:\Users\Usuario\Documents\ai-toolkit\ui\src\app\settings\page.tsx`
- `C:\Users\Usuario\Documents\ai-toolkit\ui\src\app\api\settings\route.ts`
- `C:\Users\Usuario\Documents\ai-toolkit\ui\package.json`
- `C:\Users\Usuario\Documents\ai-toolkit\aitk_db.db`
- `C:\Users\Usuario\Documents\ai-toolkit\docker-compose.yml`

The database path may not exist in a fresh checkout but is the compose-mounted production path. Locate the actual live database and deployment process before migration; back them up before applying schema or deployment changes.

## Implementation approach

1. Read the full plan and all directly relevant documents above. Inspect current code and tests before changing anything.
2. Run EPH-01 first using current official RunPod documentation/source and a tightly bounded disposable Pod. Search the web when provider APIs, prices, GPU identifiers, proxy behavior, or security behavior may have changed. Prefer official RunPod, ComfyUI, Krea, Hugging Face, and upstream source material.
3. Freeze the verified provider/image/model contracts and implement the configuration and secret boundaries. Reuse the existing RunPod training client's retry/redaction principles without conflating Serverless training executions with Pods.
4. Add the dedicated Prisma workspace aggregate, state transition table, singleton lease, artifact progress, migration/backups, and crash-safe recovery.
5. Build the minimal pinned ComfyUI image, bootstrap, authenticated proxy, activity extension, queue-aware watchdog, and self-delete path. Include only required core nodes and pinned Turbo BF16 model files.
6. Refactor the workflow exporter into transport-neutral discovery/build/staging/delivery layers. Keep local export working. Make cloud construction Turbo-only and comparison-plus-baseline by default.
7. Implement the RunPod Pod lifecycle adapter with deterministic names, price/GPU/image/volume attestation, no blind retry after ambiguous create, idempotent deletion, and managed-orphan reconciliation.
8. Implement restricted resumable SFTP and deterministic manifests with immutable local snapshots and end-to-end hashes.
9. Add a separately supervised workspace worker so large hashes/uploads cannot block training reconciliation.
10. Add authenticated asynchronous API routes and the complete job-page/settings UI. The browser must be able to reload and recover durable state.
11. Implement bounded output mirroring, observability, redaction, cost estimates, operator warnings, provisioning tools, documentation, and kill switch.
12. Run all offline tests and builds, then the bounded live acceptance suite and production canary. Deploy to `https://ai-toolkit.andreayalexclub.com`, verify the full flow while local ComfyUI is down, and confirm that no managed Pod or persistent workspace storage remains afterward.

Do not make large unrelated refactors. Do not break current local ComfyUI export, local training, RunPod Serverless training, Gemini captioning, or concurrent training behavior. Use idempotent operations and durable state at every external side-effect boundary. Never infer that a Pod is gone from a timeout; retain the singleton lease until provider absence is confirmed.

## Tests and verification required

Implement every test mapped in Sections 7, 9, and 10 of the detailed plan. At minimum, run and pass:

```powershell
Set-Location 'C:\Users\Usuario\Documents\ai-toolkit\ui'
npm test
npm run build

Set-Location 'C:\Users\Usuario\Documents\ai-toolkit'
python -m unittest discover remote/runpod/comfyui/tests
python remote/runpod/comfyui/preflight.py
```

Add and run the plan's fake-provider, state-machine crash/replay, SFTP interruption/resume, model hash, auth/WebSocket, idle-watchdog, component, route, container, and secret-canary tests. Live tests must be explicitly gated, budget limited, use only approved H100s, and clean up in `finally`:

```powershell
python remote/runpod/comfyui/acceptance.py --live --max-cost <bounded-value>
```

Also verify:

- Existing test suites still pass.
- `npm run build` includes the new dedicated workspace worker and production start command.
- Raw and quantized model names are absent from generated cloud bundles and the remote image.
- A Raw-trained real job produces a Turbo BF16 comparison workflow.
- All checkpoints plus No LoRA is the default; single checkpoint remains usable.
- Both 9:16 and 16:9 generate successfully.
- Local ComfyUI can remain stopped.
- Controller restart during upload resumes and creates at most one Pod.
- Controller shutdown does not prevent idle self-delete or provider hard expiry.
- Manual and automatic paths terminate rather than stop.
- Public HTTP/WebSocket access fails without authentication.
- No secret canary appears in browser responses, logs, SQLite, manifests, workflows, command arguments, or committed files.
- The final RunPod sweep finds no `aitk-comfy-*` Pod or persistent workspace storage.

## Deployment and handoff requirements

- Back up the live SQLite database and deployment configuration before schema changes.
- Deploy first with `AI_TOOLKIT_RUNPOD_COMFY_ENABLED=0`; perform migration, build, offline checks, and read-only preflight.
- Enable only for an operator canary, run the bounded production acceptance flow, inspect cost and cleanup, then enable the job action.
- The kill switch must block new workspaces but continue reconciling and terminating existing ones.
- Never roll back while a workspace may still be billable; confirm provider absence first.
- Update all relevant documentation with exact build, provisioning, secret setup, normal use, incident response, orphan cleanup, key rotation, rollback, and recovery procedures.
- Commit the completed implementation and report the branch, commit hashes, tests run, live resources created/deleted, production deployment status, remaining limitations, and direct URLs used for verification.

The task is complete only when the plan's definition of done is genuinely satisfied, the feature is usable from the public AI Toolkit job page with local ComfyUI down, all required code and documentation are committed, and the final provider sweep proves there are no leaked billable or persistent workspace resources.
