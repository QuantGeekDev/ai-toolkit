# RunPod remote training for AI Toolkit

**Date:** 2026-07-25

**Status:** Implementation plan

**Target branch:** `codex/gemini-cloud-captioning`

**Primary target:** Queue a Krea 2 Raw LoRA training job on a RunPod H100 from the local AI Toolkit UI, pay for GPU time only while work is active, and monitor/download the run through the existing AI Toolkit job page.

**Related design:** [`RUNPOD_REMOTE_TRAINING.md`](../RUNPOD_REMOTE_TRAINING.md)

## 1. Executive decision

Implement RunPod as a second execution backend behind AI Toolkit's existing job and queue abstractions. Keep dataset preparation, Gemini captioning, templates, job creation, and result viewing local. At submission time, create one immutable, content-addressed training bundle, upload it to a RunPod network volume through its S3-compatible API, and submit only the bundle identity and run metadata to a queue-based RunPod Serverless H100 endpoint.

The RunPod worker will be a pinned Docker image containing this exact AI Toolkit fork. It will validate and unpack the bundle, resolve the pinned base-model snapshot, rewrite only documented path placeholders, run `run.py`, publish structured progress, and leave outputs on the network volume. A local reconciler will poll RunPod and mirror logs, metrics, samples, and LoRA checkpoints into the existing local `output/<job-name>/` folder. Existing log, loss-graph, sample, and files endpoints can then continue to work with minimal branching.

For the first release:

- Use **RunPod queue-based Serverless**, not a permanently running Pod.
- Configure `workersMin=0`, `workersMax=1`, one H100 worker, and a short idle timeout. This meets the no-idle-GPU-billing requirement while enforcing a one-job cost ceiling.
- Use asynchronous `/run`, `/status`, and `/cancel`; never send a dataset or checkpoint through the request body.
- Use a RunPod network volume for bundle staging, the Hugging Face model cache, live run state, and outputs.
- Make AWS S3 optional, for immutable backup/retention only. The local `echoflicks` AWS profile remains on the local machine and is never copied to RunPod.
- Keep the RunPod API key and storage secret in environment variables. Do not store either in job JSON, the training bundle, SQLite Settings, logs, or the browser.
- Require explicit code, image, model, config, dataset, and seed identities. Never silently change batch size, precision, quantization, gradient accumulation, resolutions, or other training parameters for H100.
- Define reproducibility as identical inputs and recorded environment, not bit-for-bit equality between an RTX 5090 and H100. Cross-architecture floating-point kernels can legitimately diverge.

The API key previously pasted into chat must be treated as compromised and revoked before any implementation smoke test. This plan intentionally does not repeat, persist, or use it.

## 2. Requirements distilled from the request

### Functional requirements

1. A training job can choose **Local GPU** or **RunPod H100** without changing its training configuration.
2. Remote submission exports a self-contained bundle containing the dataset, portable config template, and manifest.
3. Export validates captions, image formats, duplicate names, Gemini failure/refusal text, trigger use, and path portability before any paid compute starts.
4. The local UI can queue, start, observe, safely stop, resume, and inspect a remote run.
5. Logs, step count, speed, loss graph, samples, checkpoints, and final LoRA files appear in the same job page used for local runs.
6. A local UI or machine restart does not lose ownership of an in-flight RunPod job.
7. A repeated click, HTTP timeout, worker retry, or reconciler restart cannot start the same logical training run twice.
8. Completed artifacts remain recoverable after RunPod's short API-result retention expires.
9. The implementation supports Krea 2 Raw now but does not hard-code its model ID into the generic transport.
10. A later ephemeral-Pod backend can reuse the bundle, artifact, execution, and UI contracts.

### Operational requirements

- No active RunPod worker while the endpoint is idle.
- One remote training run at a time by default.
- A hard execution timeout and a total TTL are required for every submission.
- Queue delay, cold start, running time, artifact-sync time, and terminal result are visible separately.
- Uploads and downloads are resumable and verified by checksum.
- A remote failure must never overwrite a known-good local checkpoint.
- Local training remains the default and behaves exactly as it does today when the feature is disabled.

### Security requirements

- `RUNPOD_API_KEY`, RunPod S3 secret, `HF_TOKEN`, AWS credentials, and signed URLs are never serialized into the bundle or Job record.
- The browser only receives configured/not-configured status for secrets.
- Worker inputs use fixed storage roots and relative object keys; arbitrary URLs and absolute paths are rejected.
- Archive extraction rejects traversal paths, symlinks, hard links, device files, excessive file count, and decompression bombs.
- Logs and error objects are redacted before persistence or API responses.
- Deleting a local job does not silently delete remote/archive data; remote purge is a separate confirmed operation.

### Non-goals for the first release

- General multi-cloud scheduling.
- Multiple simultaneous remote training workers.
- Spot/preemptible recovery.
- Distributed or multi-GPU training.
- Remote dataset editing or remote Gemini captioning.
- Bitwise-identical output across different GPU architectures.
- Automatically provisioning RunPod billing, API keys, network volumes, or registry accounts.
- Publicly exposing the local AI Toolkit UI as a webhook receiver.
- Making AWS S3 mandatory.

## 3. Current-system findings that shape the implementation

- `ui/cron/actions/processQueue.ts` is the current scheduler. It selects one queued job for each `gpu_ids` queue and calls `startJob`.
- `ui/cron/actions/startJob.ts` is the correct dispatch boundary. It currently rewrites the SQLite path, writes `.job_config.json`, injects server-side credentials, spawns local Python, and records a PID.
- `ui/prisma/schema.prisma` has `Settings`, `Queue`, and `Job`; remote provider IDs, immutable bundle identity, attempts, heartbeats, and artifact-sync state do not yet have a durable home.
- `DiffusionTrainer` uses the shared local SQLite database for progress and control flags. A RunPod worker cannot safely or directly use the local Windows database. The worker therefore needs a private remote control database plus an explicit progress/artifact bridge.
- AI Toolkit's `UILogger` writes `loss_log.db`. Copying a live SQLite file through object storage can produce a torn database; live metrics must be exported as immutable chunks or through SQLite's backup API.
- The existing UI reads `output/<job-name>/log.txt`, `loss_log.db`, `samples/`, and checkpoint files. Mirroring remote artifacts into this shape reuses `JobOverview`, `JobLossGraph`, `SampleImages`, and `FilesWidget`.
- `ui/src/app/api/jobs/[jobID]/stop/route.ts` only understands local PIDs. Remote stop needs backend dispatch and a graceful-stop phase before forced RunPod cancellation.
- `ui/src/app/api/jobs/[jobID]/delete/route.ts` recursively removes the local output directory. It must not attempt remote deletion implicitly.
- `run_modal.py` is useful prior art inside this repository: it runs AI Toolkit remotely and persists outputs. It also demonstrates what not to carry forward: mounting the entire mutable checkout, floating dependencies, manual path editing, and no durable integration with the local UI.
- Upstream AI Toolkit documents both a RunPod Pod template and Modal flow. The official flow uploads the project/dataset and retrieves a persistent volume manually; this plan preserves those core mechanics but replaces manual copying with an immutable bundle and durable UI orchestration.
- The custom Gemini captioner records failures, provider, model, and prompt settings in its job configuration, but successful dataset provenance is not yet stored beside the dataset. Export cannot prove the caption prompt/model later unless captioning writes dataset-level provenance.
- The dataset tree may contain `_latent_cache`, `_t_e_cache`, `.aitk_size.json`, old captions, thumbnails, and temporary files. Export must use an explicit allowlist rather than tarring the directory recursively.
- UI unit tests use Vitest and Python tests use `unittest`; both can be extended without introducing another test framework.

## 4. External research and patterns to adopt

### RunPod platform constraints

- RunPod's [endpoint configuration reference](https://docs.runpod.io/serverless/endpoints/endpoint-configurations) supports zero active workers, maximum-worker limits, a short idle timeout, per-job execution timeouts up to seven days, and job TTLs up to seven days. Use zero active workers and one maximum worker for the initial cost envelope.
- Async [`/run` requests](https://docs.runpod.io/serverless/endpoints/send-requests) are intended for long-running work, but API results are retained for only 30 minutes after completion. Large or durable results therefore belong in storage, not the handler return value.
- The same request guide caps `/run` payloads at 10 MB. A dataset archive must be uploaded separately and referenced by object key/digest.
- The official [operation reference](https://docs.runpod.io/serverless/endpoints/operation-reference) provides `/status`, `/retry`, and `/cancel`. `/cancel` stops an in-progress job immediately, so it is a force-cancel fallback, not the first step of a checkpoint-safe stop.
- The worker SDK exposes [`runpod.serverless.progress_update`](https://docs.runpod.io/serverless/workers/handler-functions), whose latest value appears in status polling. Use it for low-latency UI progress, while also persisting durable state on the network volume.
- [Network volumes](https://docs.runpod.io/storage/network-volumes) persist across workers but restrict workers to the volume's data center. Multiple volumes do not synchronize, and simultaneous writes to the same file can corrupt data. Each execution therefore owns a unique prefix and only one worker writes its live files.
- RunPod's [S3-compatible volume API](https://docs.runpod.io/storage/s3-api) allows upload/download without renting a GPU. Its documented limitations around very large file counts support using one bundle archive plus immutable progress/log chunks rather than synchronizing thousands of tiny objects repeatedly.

### Open-source patterns

- The official [`runpod-workers/worker-template`](https://github.com/runpod-workers/worker-template) separates a small `handler.py`, pinned container build, local `test_input.json`, and deployable image. Mirror that layout under `remote/runpod/`, but keep model loading inside AI Toolkit rather than in the handler.
- The official [`runpod-python`](https://github.com/runpod/runpod-python) repository includes local worker testing and startup fitness checks. Add checks for CUDA/H100 capability, mounted volume, free disk, image/commit identity, and required model access before accepting a paid run.
- [`runpod-workers/worker-comfyui`](https://github.com/runpod-workers/worker-comfyui) uses async API submission and optionally moves large outputs to S3 rather than returning base64 payloads. Adopt the artifact-reference pattern; do not return checkpoints from the handler.
- [SkyPilot Managed Jobs](https://docs.skypilot.co/en/latest/examples/spot-jobs.html) treats checkpointing, recovery, controller state, and persistent storage as separate concerns. Adopt its principle that infrastructure retries are safe only when application checkpoints are durable and resume-aware; do not blindly retry arbitrary training failures.
- Upstream [`ostris/ai-toolkit`](https://github.com/ostris/ai-toolkit) documents that stopping during a save can corrupt that checkpoint and that resume discovers the latest saved state. Remote stop must set AI Toolkit's control flag and wait for an acknowledgement between save boundaries before escalating.
- `sd-scripts` keeps dataset configuration separate from training configuration and validates duplicate dataset definitions. Its [dataset config documentation](https://github.com/kohya-ss/sd-scripts/blob/main/docs/config_README-en.md) reinforces using a normalized portable config rather than textual search-and-replace over arbitrary YAML.

### Patterns deliberately not adopted

- Do not mount or upload the entire local repository per run, as `run_modal.py` does. Code belongs in an immutable worker image; only data/config/provenance belong in the bundle.
- Do not use a public webhook to the user's laptop. Polling from the existing cron worker survives NAT, dynamic addresses, and a closed browser.
- Do not make the RunPod API response the artifact catalog. Its retention is shorter than a training workflow's useful life.
- Do not automatically call `/retry` for out-of-memory, invalid config, corrupt data, or deterministic Python exceptions. Those failures will repeat and waste money.
- Do not use a shared live SQLite database across the S3 facade. Use worker-local SQLite plus immutable synchronization records.

## 5. Reproducibility contract

### Reproducibility levels

| Level                      | Promise                                                                                                                                                                                 | Required inputs                 |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| R1: provenance-equivalent  | Same dataset bytes, resolved config, code commit, container digest, model snapshot, dependencies, seeds, and requested hardware are recorded and verifiable. Numeric output may differ. | Default for all remote runs     |
| R2: environment-equivalent | R1 plus local comparison run uses the same Linux container image, CUDA/PyTorch stack, and path resolver.                                                                                | Optional local-container runner |
| R3: deterministic-attempt  | R2 plus deterministic PyTorch flags and unsupported nondeterministic operations fail closed. Performance can fall and some models may not support it.                                   | Explicit opt-in experiment mode |

No level promises bitwise-equal RTX 5090 and H100 weights. Acceptance compares identities, ability to resume, loss/sample behavior, and bounded numeric tolerance where useful.

### Identity fields required for every remote execution

- Canonical bundle content digest and archive SHA-256.
- SHA-256 and byte length for every included image, caption, validation image, and config payload.
- Source repository URL, Git commit, branch label, and dirty flag.
- Worker OCI image name plus immutable digest; mutable tags alone are rejected.
- Hash of the Python dependency lock and worker Dockerfile.
- AI Toolkit config schema version and exporter version.
- Base model repository plus resolved Hugging Face commit SHA; never only `krea/Krea-2-Raw`.
- Training `SEED`, sample seeds, CUDA/PyTorch versions, requested GPU type, and actual GPU model reported by the worker.
- Original dataset root as display-only provenance, never as an executable path.
- Caption provider, model, prompt/template ID, prompt hash, captioning timestamp, and failure count.
- Trigger word and trigger coverage summary after resolving `[trigger]`.

### Dirty-tree policy

Remote submission is blocked when the local training code is dirty or its commit does not match the worker image label. Dataset/config/template changes are represented by the bundle and are allowed. To test code changes on this branch, commit them, build/push the worker image from that commit, and configure its digest. An explicit developer-only override may be added later, but it must embed a patch hash and mark the run non-reproducible; it is not part of MVP.

## 6. Proposed architecture

```text
Local AI Toolkit UI and SQLite
        |
        | create Job(execution_target=runpod_serverless)
        v
Queue worker / dispatcher
        |
        +--> validate dataset + resolve model revision
        +--> deterministic krea2-v1-<digest>.tar.gz
        +--> upload + verify through RunPod volume S3 API
        +--> POST /run {execution_id, bundle_key, digests, policy}
        v
RunPod queue (workersMin=0, workersMax=1, H100 only)
        |
        v
Pinned AI Toolkit worker image
        |
        +--> fitness checks
        +--> claim execution idempotently
        +--> verify/extract bundle safely
        +--> materialize portable paths + private control DB
        +--> run python run.py resolved-config.json
        +--> publish progress_update + immutable state/log/metric manifests
        +--> persist samples/checkpoints/final result on network volume
        v
Local reconciler (survives UI/browser restart)
        |
        +--> poll /status and volume state
        +--> update Job + RemoteExecution
        +--> append log chunks
        +--> import metric chunks into local loss_log.db
        +--> checksum-download samples and LoRA checkpoints
        v
Existing AI Toolkit job page and ComfyUI-visible local files
```

### Execution-state ownership

- `RemoteExecution.state` is authoritative for remote lifecycle detail.
- `Job.status` remains the compatibility projection used by existing lists/actions.
- RunPod `/status` is authoritative for infrastructure state while retained.
- `runs/<execution-id>/state/current.json` is authoritative durable worker state after API retention.
- A final `result.json` plus `COMPLETE` marker is the success commit. Output files without the marker are partial and never imported as completed.
- The local reconciler is the only writer to the local Job/RemoteExecution rows for remote progress.
- The remote worker is the only writer to its live run prefix, except for immutable control request objects written by the local controller.

### State mapping

| RemoteExecution state         | Job.status              | Job.info                                                  |
| ----------------------------- | ----------------------- | --------------------------------------------------------- |
| `preparing_bundle`            | `running`               | Validating and packaging dataset                          |
| `uploading`                   | `running`               | Uploading training bundle                                 |
| `submitted` / `in_queue`      | `running`               | Waiting for RunPod H100                                   |
| `starting`                    | `running`               | Starting remote worker                                    |
| `running`                     | `running`               | Worker phase or trainer status                            |
| `stop_requested`              | `running` + `stop=true` | Waiting for safe stop                                     |
| `force_cancelling`            | `stopping`              | Force-cancelling RunPod job                               |
| `syncing`                     | `running`               | Downloading and verifying artifacts                       |
| `completed`                   | `completed`             | Remote training completed                                 |
| `stopped`                     | `stopped`               | Stopped safely at checkpoint boundary                     |
| `cancelled`                   | `stopped`               | Cancelled; last verified checkpoint retained              |
| `failed` / `timed_out`        | `error`                 | Sanitized actionable failure                              |
| `submission_unknown` / `lost` | `error`                 | Provider state needs reconciliation; do not auto-resubmit |

The UI should display the granular remote state separately; the compatibility projection prevents broad breakage in existing components.

## 7. File and data contracts

### Bundle layout

```text
krea2-v1-<content-digest>.tar.gz
|-- dataset/
|   |-- 0001.png
|   |-- 0001.txt
|   `-- ...
|-- validation/                 # optional, not used for gradients
|   |-- 0001.png
|   `-- ...
|-- train.template.yaml
`-- manifest.json
```

Caches, `.aitk_size.json`, thumbnails, previous output, optimizer state, hidden files, and arbitrary dataset-root files are excluded unless a future manifest schema explicitly allows them.

### Portable config placeholders

Only typed values at known config paths may contain placeholders:

- `${AITK_DATASET_DIR}`
- `${AITK_VALIDATION_DIR}`
- `${AITK_OUTPUT_DIR}`
- `${AITK_CONTROL_DB}`
- `${AITK_MODEL_DIR}`

The exporter parses config JSON/YAML, replaces exact known path fields, serializes a canonical template, and then reparses it. It must not perform global string replacement. The worker rejects unresolved `${...}` tokens and any absolute Windows, UNC, POSIX host, or `file://` path after resolution.

### Manifest outline

```json
{
  "schemaVersion": 1,
  "bundleType": "aitk-training-bundle",
  "contentDigest": "sha256:...",
  "createdAt": "2026-07-25T00:00:00Z",
  "exporter": { "version": "1", "gitCommit": "..." },
  "training": {
    "name": "analog-horror-v2",
    "architecture": "krea2",
    "triggerWord": "nightmarish analog broadcast style",
    "seed": 42,
    "configSha256": "..."
  },
  "model": {
    "repository": "krea/Krea-2-Raw",
    "revision": "<resolved-hf-commit>",
    "licenseAcknowledged": true
  },
  "captioning": {
    "provider": "gemini",
    "model": "gemini-3.1-pro-preview",
    "promptTemplateId": "...",
    "promptSha256": "...",
    "completedAt": "...",
    "failureCount": 0
  },
  "dataset": {
    "imageCount": 40,
    "captionCount": 40,
    "triggerCoverage": { "resolved": 40, "missing": 0, "duplicated": 0 },
    "files": [
      {
        "path": "dataset/0001.png",
        "bytes": 1234,
        "sha256": "...",
        "mediaType": "image/png"
      },
      {
        "path": "dataset/0001.txt",
        "bytes": 234,
        "sha256": "...",
        "mediaType": "text/plain; charset=utf-8"
      }
    ]
  },
  "runtime": {
    "workerImageDigest": "registry/name@sha256:...",
    "dependencyLockSha256": "...",
    "requiredSecrets": ["HF_TOKEN"]
  }
}
```

`createdAt` is provenance and would normally make an archive vary. For deterministic export, it is sourced from an explicit export epoch stored with the export record; rebuilding the same recorded export uses the same epoch. A new export record may have a new archive identity even if its logical dataset is unchanged. The content digest excludes display-only timestamps and is calculated from canonical semantic content.

### Deterministic archive rules

- Sort entries by normalized UTF-8 POSIX path.
- Normalize Unicode filenames to NFC and reject normalization/case-fold collisions.
- Use fixed file modes, uid/gid `0`, blank owner/group, and a fixed recorded mtime.
- Use gzip timestamp `0`.
- Hash each file while streaming; do not load the full dataset into memory.
- Calculate `contentDigest` from canonical JSON containing file path, size, file hash, normalized config, and manifest semantic fields.
- Calculate archive SHA-256 after close and store it in the export record/upload metadata, avoiding a self-referential field inside the archive.
- Write `*.partial`, fsync/close, verify by reopening, then atomically rename.

### Remote object layout

```text
/runpod-volume/aitk/
|-- bundles/<content-digest>/bundle.tar.gz
|-- bundles/<content-digest>/bundle.sha256
|-- models/huggingface/<repo>/<revision>/...
`-- runs/<execution-id>/
    |-- claim.json
    |-- input/manifest.json
    |-- work/config.resolved.json
    |-- work/control.db
    |-- control/000001-stop-request.json
    |-- state/current.json
    |-- state/events/000001.json
    |-- logs/index.json
    |-- logs/000001.txt
    |-- metrics/index.json
    |-- metrics/000001.jsonl
    |-- artifacts/index.json
    |-- output/samples/...
    |-- output/checkpoints/...
    |-- result.json
    `-- COMPLETE
```

Index and state files are written to a sibling temporary name and atomically renamed on the mounted filesystem. Chunks are immutable once indexed. The local reconciler downloads only unseen chunk numbers and checksum-verifies every material artifact.

### RunPod request contract

```json
{
  "input": {
    "schemaVersion": 1,
    "executionId": "local-uuid",
    "requestKey": "sha256:job+attempt+bundle+config+image",
    "bundleKey": "aitk/bundles/<digest>/bundle.tar.gz",
    "bundleContentDigest": "sha256:...",
    "bundleArchiveSha256": "...",
    "runPrefix": "aitk/runs/<execution-id>",
    "expectedWorkerImageDigest": "sha256:..."
  },
  "policy": {
    "executionTimeout": 10800000,
    "ttl": 21600000,
    "lowPriority": false
  }
}
```

No token, caption content, raw config, path, or dataset byte is sent in the API JSON. The endpoint mounts the configured network volume. Request and response schemas have strict maximum lengths and reject unknown dangerous fields.

### Progress event contract

```json
{
  "schemaVersion": 1,
  "sequence": 42,
  "executionId": "...",
  "timestamp": "...",
  "phase": "training",
  "step": 750,
  "totalSteps": 2000,
  "info": "Training",
  "speed": "2.10 sec/iter",
  "lastCheckpointStep": 500,
  "heartbeat": true
}
```

Events are monotonic by `sequence`. The reconciler ignores duplicates and stale/out-of-order updates, but still records terminal provider states. Progress sent through `progress_update` is a compact JSON string bounded well below platform payload limits.

## 8. Database changes

Add a dedicated execution record rather than overloading `Job.info` with JSON:

```prisma
model Job {
  // existing fields remain
  execution_target String @default("local") // local | runpod_serverless
  remoteExecutions RemoteExecution[]
}

model RemoteExecution {
  id                       String   @id @default(uuid())
  job_id                   String
  job                      Job      @relation(fields: [job_id], references: [id], onDelete: Cascade)
  attempt                  Int
  provider                 String   @default("runpod")
  state                    String
  phase                    String   @default("")
  request_key              String   @unique
  provider_job_id          String?  @unique
  endpoint_id              String
  bundle_content_digest    String
  bundle_archive_sha256    String
  bundle_object_key        String
  run_prefix               String
  worker_image_digest      String
  requested_gpu            String
  actual_gpu               String?
  progress_json            String   @default("{}")
  last_event_sequence      Int      @default(0)
  last_heartbeat_at        DateTime?
  submitted_at             DateTime?
  started_at               DateTime?
  finished_at              DateTime?
  stop_requested_at        DateTime?
  artifact_sync_state      String   @default("pending")
  result_json              String   @default("{}")
  error_code               String?
  error_message            String?
  created_at               DateTime @default(now())
  updated_at               DateTime @updatedAt

  @@unique([job_id, attempt])
  @@index([state])
  @@index([job_id])
}
```

Keep `gpu_ids` for local compatibility. Remote jobs use the namespaced queue key `runpod:h100` in `gpu_ids`; `execution_target` decides dispatch behavior. The UI renders that key as `RunPod H100`, not as a local GPU. A future schema cleanup can rename Queue's `gpu_ids` to `queue_key`, but that migration is not required to deliver the feature safely.

Migration behavior:

- Existing rows backfill to `execution_target="local"`.
- Existing queue behavior and indexes remain.
- A migration test starts from a copy of the old schema/database and proves all jobs and settings remain readable.
- `update_db` remains usable, but release notes require backing up `aitk_db.db` before first launch with this version.

## 9. Error taxonomy and policy

| Code                         | Example                                      |                        Retry? | Remediation                                                          |
| ---------------------------- | -------------------------------------------- | ----------------------------: | -------------------------------------------------------------------- |
| `REMOTE_CONFIG_MISSING`      | Endpoint ID or storage endpoint absent       |                            No | Fail before export; link to Settings                                 |
| `REMOTE_AUTH_FAILED`         | RunPod 401/403                               |                            No | Rotate/configure key; redact headers                                 |
| `REMOTE_RATE_LIMITED`        | 429                                          |                  Yes, bounded | Honor delay; exponential backoff with jitter                         |
| `REMOTE_CAPACITY_WAIT`       | H100 remains queued                          |                          Poll | Show queue duration; never fall back to another GPU silently         |
| `REMOTE_SUBMISSION_UNKNOWN`  | POST timed out after body sent               |         No automatic resubmit | Query provider requests/claim; require recovery action if unresolved |
| `BUNDLE_VALIDATION_FAILED`   | Empty caption, refusal, unsupported image    |                            No | Show per-file report; no upload/charge                               |
| `BUNDLE_UPLOAD_FAILED`       | Network interruption                         |                Yes, resumable | Continue multipart/upload; verify final checksum                     |
| `BUNDLE_CHECKSUM_MISMATCH`   | Corrupt object                               |     Once from clean re-upload | Delete only partial object; never run it                             |
| `WORKER_IDENTITY_MISMATCH`   | Container digest/commit differs              |                            No | Fail before model load                                               |
| `MODEL_REVISION_UNAVAILABLE` | Gated/removed snapshot                       |                            No | Fix access/revision; preserve bundle                                 |
| `DATASET_EXTRACT_REJECTED`   | Tar traversal/symlink/bomb                   |                            No | Quarantine bundle; security error                                    |
| `CUDA_OOM`                   | Invalid memory assumptions                   |            No automatic retry | Keep config unchanged; user decides a new attempt                    |
| `TRAINING_CONFIG_ERROR`      | Invalid option/path/architecture             |                            No | Surface sanitized traceback and resolved config hash                 |
| `TRAINING_TRANSIENT_INFRA`   | Worker eviction/hardware error               | Only from verified checkpoint | Create a new attempt referencing checkpoint hash                     |
| `REMOTE_HEARTBEAT_STALE`     | No progress during threshold                 |            Poll before action | Check RunPod state; do not assume failure during model load/save     |
| `STOP_GRACE_EXPIRED`         | Trainer did not acknowledge control flag     |   User-confirmed force cancel | Warn about latest in-progress checkpoint; call `/cancel`             |
| `ARTIFACT_CHECKSUM_MISMATCH` | Partial/corrupt local download               |                           Yes | Keep `.partial`; retry; never replace good local file                |
| `REMOTE_RESULT_EXPIRED`      | `/status` is 404 after retention             |             No provider retry | Recover from durable volume state/result                             |
| `REMOTE_STATE_LOST`          | Neither API nor volume has a terminal record |            No automatic rerun | Mark lost and retain forensic metadata                               |

All retry loops are bounded, use full jitter, and are injectable in tests. Provider retries, upload retries, and worker retries must not multiply unexpectedly.

## 10. Implementation tickets

Estimates are engineering days for one contributor familiar with the fork. They include focused unit tests but not waiting time for H100 capacity. Tickets should land in dependency order unless explicitly marked parallel.

### Milestone 0: security and contracts

#### RPT-000 - Revoke exposed credential and establish environment-only secret policy

**Estimate:** 0.5 day
**Dependencies:** None
**Owner area:** Operations / security

**Outcome**

The previously exposed RunPod key is unusable, no repository file contains it, and developers have documented environment-variable names for all remote credentials.

**Implementation**

- Revoke the exposed RunPod API key in the RunPod console and create a replacement with the minimum available scope.
- Run secret scanning over tracked files, untracked files intended for commit, Git history being pushed, generated bundles, and output logs. Search by known RunPod key prefixes as well as the exact revoked value locally without printing the match.
- Add `.env.example` entries with empty values only:
  - `RUNPOD_API_KEY`
  - `RUNPOD_ENDPOINT_ID`
  - `RUNPOD_S3_ENDPOINT`
  - `RUNPOD_S3_ACCESS_ID`
  - `RUNPOD_S3_SECRET`
  - `RUNPOD_NETWORK_VOLUME_ID`
  - optional `RUNPOD_WORKER_IMAGE_DIGEST`
- Confirm `.env`, worker test inputs, bundle output directories, and remote credential files are ignored.
- Document that RunPod endpoint worker secrets such as `HF_TOKEN` are configured in RunPod, not forwarded from the local UI request.
- Add a shared redaction helper that removes authorization headers, known credential fields, signed query strings, and token-like values before error logging.

**Error handling and gotchas**

- A key remains compromised even if the chat or local file is deleted; rotation is mandatory.
- Do not test redaction with a real active key. Generate structurally similar fake values.
- Environment-variable presence may be reported as a boolean/source but never returned verbatim.
- Avoid passing secrets on a command line because process listings and shell history can expose them.

**Tests**

- Unit-test redaction of nested Axios errors, request headers, URLs with signed query parameters, and plain-text exception messages.
- Unit-test that serialized settings/API responses contain only configured/source flags.
- CI secret-scan fixture contains fake token-shaped strings in a blocked fixture and proves the scanner fails without displaying the full value.

**Acceptance criteria**

- The old key returns unauthorized when tested directly outside automated logs.
- `git grep`, staged diff inspection, bundle inspection, and a job API response contain no credential value.
- Starting a remote job without required environment secrets fails before export with an actionable, sanitized message.

#### RPT-001 - Freeze remote execution, bundle, progress, and artifact schemas

**Estimate:** 1 day
**Dependencies:** RPT-000
**Likely files:** `remote/contracts/*.json`, `ui/src/helpers/remoteContracts.ts`, `toolkit/remote/contracts.py`, `docs/remote-training.md`

**Outcome**

TypeScript and Python share versioned JSON Schemas and golden fixtures for every boundary described in Sections 7 and 8.

**Implementation**

- Add JSON Schema Draft 2020-12 definitions for:
  - bundle manifest;
  - RunPod request and final result;
  - progress event and durable state;
  - artifact index and immutable log/metric indexes;
  - control request and acknowledgement.
- Use `additionalProperties: false` for network-facing records. Allow an explicit `extensions` object only where forward compatibility is required.
- Establish integer, string-length, file-count, path-length, archive-size, and event-sequence bounds.
- Generate or hand-maintain matching narrow TypeScript and Python types with validation at all trust boundaries.
- Add golden valid/invalid fixtures consumed by both language test suites.
- Document compatibility rules: readers accept their version and explicitly listed older versions; unknown major versions fail closed.

**Error handling and gotchas**

- JavaScript numbers cannot precisely represent arbitrary 64-bit integers. File sizes and sequence values must stay within safe integer bounds or use decimal strings.
- Reject `NaN`, infinity, duplicate JSON keys, and ambiguous Unicode keys.
- Keep provider-specific fields out of the portable training config and under a remote execution envelope.

**Tests**

- Cross-language contract test validates the same golden fixtures in Python and TypeScript.
- Fuzz invalid types, overlong strings, unknown fields, duplicate keys, path traversal, and negative counters.
- Snapshot canonical JSON output so key ordering and hashing do not drift accidentally.

**Acceptance criteria**

- One documented schema version is used by exporter, UI, client, and worker.
- Invalid network or archive input fails before side effects.
- A schema change requires an explicit fixture/version update in CI.

#### RPT-002 - Add RemoteExecution persistence and migration-safe repository

**Estimate:** 1.5 days
**Dependencies:** RPT-001
**Likely files:** `ui/prisma/schema.prisma`, `ui/src/server/remoteExecutions.ts`, Prisma-generated client, tests under `ui/src/server/`

**Outcome**

Remote attempts survive app restarts and have atomic, validated state transitions without changing existing local-job behavior.

**Implementation**

- Add `Job.execution_target` and the `RemoteExecution` model from Section 8.
- Wrap creation, state transition, event-sequence advancement, provider-ID assignment, and terminalization in a repository module.
- Encode allowed state transitions in one table/function; reject regressions such as `completed -> running`.
- Allocate attempts transactionally using the maximum attempt for the Job.
- Make `request_key` unique and provider job ID unique when non-null.
- Add a query for active/uncertain executions used on cron-worker startup.
- Make terminalization idempotent: repeated identical terminal reports are no-ops; conflicting reports are retained as reconciliation diagnostics rather than overwriting success.
- Add backup/upgrade notes for SQLite and test `prisma db push` from the previous schema.

**Error handling and gotchas**

- The cron loop runs every second; two overlapping app instances must not both dispatch the same row. Use a transaction/compare-and-set state update before external calls.
- `updated_at` alone is not an event cursor.
- Cascading deletion removes execution metadata only after the user confirms local job deletion; remote artifacts remain untouched and should be reported before deletion.

**Tests**

- Unit-test every allowed and forbidden state transition.
- Concurrent attempt-allocation and claim tests prove only one dispatcher wins.
- Migration fixture contains stopped, queued, running, caption, and completed legacy jobs and retains them unchanged with `execution_target=local`.
- Terminal idempotency tests include duplicate, stale, and conflicting provider events.

**Acceptance criteria**

- Restarting the worker process discovers an active execution with all provider and artifact identifiers intact.
- Legacy local jobs still queue, run, stop, edit, and delete.
- No external API call is made before a durable execution row has been claimed.

### Milestone 1: deterministic bundle export

#### RPT-003 - Persist successful Gemini caption provenance beside each dataset

**Estimate:** 1 day
**Dependencies:** RPT-001
**Likely files:** `extensions_built_in/captioner/CloudCaptioner.py`, `extensions_built_in/captioner/providers/base.py`, `testing/test_cloud_captioner.py`

**Outcome**

The exporter can prove which prompt, template, provider, and model produced the current caption set without consulting transient UI history.

**Implementation**

- Write `.aitk_caption_provenance.json` in the dataset root at the end of a caption run using temp-file plus `os.replace`.
- Record provider/backend, exact model ID, prompt template ID, full prompt SHA-256, optional full prompt text (default included because the requirement calls for it), start/end timestamps, recaption setting, image/caption counts, blocked/failed counts, and caption-job ID.
- Record a deterministic map of image relative path to final caption SHA-256 and request metadata that is safe to retain. Never store credentials or raw authorization errors.
- Only replace the prior provenance file after the run reaches its defined completion policy. For a partial run, write a separate `.aitk_caption_provenance.partial.json` and keep the last complete record.
- On manual caption edit, mark provenance stale. A lightweight caption index/hash check during export also detects edits made outside the UI.

**Error handling and gotchas**

- A caption job with per-image failures is not a complete provenance set. Export blocks by default unless every exported image hash has a successful caption hash.
- Prompt text may contain personal or licensed instructions; show it in export review and allow an explicit metadata-redaction mode only if prompt hash/model remain. The strict reproducibility preset keeps it.
- Renamed image files invalidate the mapping even if bytes match; exporter can offer a non-mutating diagnostic but not guess silently.

**Tests**

- Complete, partial, cancelled, blocked-response, recaption, and manual-edit scenarios.
- Atomicity test interrupts before replace and proves the prior complete provenance remains valid.
- Secret canary in provider configuration never appears in provenance.

**Acceptance criteria**

- A freshly Gemini-captioned dataset passes provenance validation.
- Editing one caption makes export report that exact file as stale.
- Provider/model/prompt and their hashes appear in `manifest.json`.

#### RPT-004 - Implement exhaustive training-bundle validator

**Estimate:** 2 days
**Dependencies:** RPT-001, RPT-003
**Likely files:** `toolkit/training_bundle/validator.py`, `toolkit/training_bundle/types.py`, `testing/test_training_bundle_validator.py`

**Outcome**

All known dataset/config problems are reported together before upload or paid execution.

**Implementation**

- Discover files from the configured dataset blocks, not by blindly walking a user-selected folder.
- Allow only supported image extensions and verify content with an image decoder; extension and magic type must agree or be explicitly normalized during export.
- Require exactly one non-empty UTF-8 caption sidecar per training image using the configured `caption_ext`.
- Detect duplicate relative names, Windows case-insensitive collisions, Unicode normalization collisions, duplicate stems across extensions, repeated image bytes, and image/caption count mismatch.
- Reject symlinks, junctions/reparse points, FIFOs, devices, sockets, sparse-file abuse, and files that change size/mtime/hash during export.
- Detect known Gemini refusal/error boilerplate using structured provenance first and a conservative configurable text classifier second. Avoid rejecting legitimate captions merely containing words such as “error” in a visible sign.
- Parse every image, apply EXIF orientation for metadata checks, and enforce configurable minimum dimensions, maximum pixels, maximum encoded bytes, and decompression-bomb limits.
- Validate masks/control images if configured; remote MVP blocks unsupported dataset features rather than dropping them.
- Resolve `[trigger]` exactly as the trainer does and report missing, duplicate, mixed literal/placeholder, whitespace, and case mismatch. Generic default is warning; template metadata can set `requireTriggerInEveryCaption=true` as a blocking rule.
- Validate all dataset blocks, validation items, sample control paths, model paths, output paths, and SQLite path for portability.
- Produce machine-readable and UI-friendly reports with `errors`, `warnings`, counts, paths, and remediation.
- Keep validation read-only.

**Error handling and gotchas**

- `1.jpg` plus `1.png` with one `1.txt` is ambiguous and must fail.
- `A.jpg` and `a.jpg` may work on Linux but collide on Windows; fail on all platforms for portable identity.
- Captions containing only BOM/whitespace are empty.
- Do not follow symlinks even if their target is inside the dataset; the target can change between validation and archive creation.
- Dataset mutation between validation and streaming must abort and delete only the partial archive.
- `_latent_cache` and `_t_e_cache` are ignored, not reported as unsupported image files.

**Tests**

- Table-driven tests for every validation rule above.
- Image fixtures: valid JPEG/PNG/WebP, unsupported GIF/TIFF/AVIF, corrupt bytes, wrong extension, EXIF rotation, CMYK, transparent PNG, huge dimensions, zero-byte file.
- Filename fixtures: Unicode composed/decomposed names, reserved Windows names, trailing dots/spaces, long paths, duplicate stems, case collision.
- Caption fixtures: empty, whitespace, refusal, quota message, JSON error object, legitimate text mentioning an error sign, NUL/control characters, invalid UTF-8, `[trigger]`, literal trigger, duplicated trigger.
- TOCTOU test mutates a file after validation and before hash completion.

**Acceptance criteria**

- The current `analog_horror` dataset returns one consolidated report and never mutates a file.
- A clean report guarantees every exported image has one usable caption.
- Any blocking error prevents archive creation and RunPod submission.

#### RPT-005 - Build deterministic, content-addressed archive exporter and importer

**Estimate:** 2 days
**Dependencies:** RPT-004
**Likely files:** `toolkit/training_bundle/exporter.py`, `toolkit/training_bundle/importer.py`, `testing/test_training_bundle_exporter.py`

**Outcome**

The same recorded export produces the same semantic digest and deterministic archive bytes, and the worker can verify/import it safely.

**Implementation**

- Stream normalized image/caption pairs into the bundle layout using canonical numbered filenames; keep an original-to-bundle path mapping in the manifest.
- Generate canonical manifest JSON and portable config YAML with stable ordering and UTF-8/LF encoding.
- Apply deterministic tar/gzip metadata rules from Section 7.
- Write the archive outside the dataset folder so discovery cannot include its own output.
- Add `verify_bundle(path)` to validate archive SHA, manifest/content digests, file hashes, counts, schema, and exact expected members.
- Add safe extraction with a preflight pass and hard limits before any member is written.
- Extract into a new temporary directory on the same filesystem and rename only after complete verification.
- Provide a local round-trip command so users can run an exported bundle locally before paying for remote compute.

**Error handling and gotchas**

- Never use `tarfile.extractall()` without validating every member and destination.
- Reject duplicate tar member names even if their bytes match.
- Apply limits to declared uncompressed size and actual bytes written.
- On Windows, tar path normalization must not create drive-relative, UNC, ADS (`name:stream`), reserved-name, or trailing-dot targets.
- If disk fills, leave a clearly named `.partial` file outside the valid bundle namespace and clean it on the next explicit export attempt.

**Tests**

- Export the same fixture twice under different host roots and assert equal content digest and archive SHA.
- Change one caption byte, config value, prompt provenance field, or image byte and assert identity changes.
- Malicious tar fixtures: `../`, absolute paths, drive paths, symlink/hardlink, duplicate names, device entry, declared-size bomb, extra unmanifested member.
- Forced short-write/disk-full/interruption leaves no valid final archive.
- Local round trip compares all manifest-listed hashes and resolved config semantics.

**Acceptance criteria**

- `verify_bundle` passes on its own output and rejects a one-byte mutation.
- An archive produced on Windows extracts to the intended Linux worker tree with identical hashes.
- Rebuilding a recorded export is byte-identical.

#### RPT-006 - Resolve immutable model revision and portable training configuration

**Estimate:** 1.5 days
**Dependencies:** RPT-004
**Likely files:** `toolkit/training_bundle/config.py`, `toolkit/training_bundle/model_revision.py`, `ui/src/server/trainingBundles.ts`, tests

**Outcome**

The remote worker loads the exact Krea 2 Raw snapshot and executes the same semantic config without local Windows paths.

**Implementation**

- Parse the saved Job config into a typed structure and limit placeholder substitution to known path fields.
- Resolve Hugging Face repository revisions to immutable commit SHAs before export using authenticated metadata access.
- Record repository, requested revision (if any), and resolved commit. If the config already points to a local model directory, either map it to a known repository/revision or block MVP export with a clear unsupported-source error.
- Have the worker materialize the snapshot into the persistent model cache, verify the resolved revision, and set `model.name_or_path` to that local snapshot path.
- Set an explicit `SEED` in execution metadata. If the Job has no training seed, require user selection rather than inheriting a mutable process environment.
- Normalize output, dataset, validation, control DB, mask, and sample control-image paths.
- Compare canonical semantic config before and after placeholder round trip; only documented path values may differ.
- Record every transformation as a JSON Patch-like list in the manifest.

**Error handling and gotchas**

- A mutable Hugging Face branch such as `main` is not a reproducible revision.
- Private/gated models need `HF_TOKEN` on both revision-resolution and worker sides; token values never enter the bundle.
- Multiple dataset blocks and optional validation/control images must each map independently.
- YAML scalars that resemble `${...}` in prompts are user content and must not be replaced unless located at a registered path field.

**Tests**

- Golden Krea 2 config from the last analog-horror job resolves to Linux paths and retains every non-path field.
- Windows drive, UNC, spaces, Unicode paths, POSIX paths, and already-portable placeholders.
- Offline fake Hugging Face resolver, gated 401, not-found revision, mutable-revision resolution, and digest mismatch.
- Semantic diff test fails if rank, learning rate, steps, precision, quantization, sample prompts, or `content_or_style` changes.

**Acceptance criteria**

- Manifest contains a commit SHA for `krea/Krea-2-Raw`.
- No host absolute path appears in the template or manifest executable fields.
- Local bundle round trip runs with the same non-path configuration as the source Job.

#### RPT-007 - Add export/preflight API and UI action

**Estimate:** 1.5 days
**Dependencies:** RPT-002, RPT-005, RPT-006
**Likely files:** `ui/src/app/api/jobs/[jobID]/export/route.ts`, `ui/src/components/JobActionBar.tsx`, `ui/src/components/TrainingBundleModal.tsx`, helpers/tests

**Outcome**

Users can validate, review, and export a bundle without starting a RunPod job.

**Implementation**

- Add a POST export endpoint that invokes a Python CLI/helper with structured JSON input, never interpolated shell text.
- Serialize exports per Job and return `409 Export already in progress` for a duplicate request.
- Stream or poll progress for validation/hashing without blocking the Next.js request indefinitely.
- Show errors and warnings grouped by captions, images, paths, trigger, provenance, config, model, and runtime identity.
- Show bundle name, content digest, archive checksum, image count, size, model revision, worker image digest, and estimated upload bytes.
- Add actions: **Validate bundle**, **Export bundle**, **Reveal file**, and later **Send to RunPod**.
- Reuse a validated archive for submission only if source file stat/hash index, config hash, provenance, image digest, and worker identity still match.

**Error handling and gotchas**

- Browser disconnect does not abort hashing and leave a corrupt final file; the server-side task owns it.
- Never accept an arbitrary output path from the browser. Export to an app-owned configured bundle directory.
- Do not expose full local source paths in API responses unless the authenticated local UI explicitly requests reveal.

**Tests**

- Route tests for missing Job, caption Job, concurrent export, validator error, worker failure, stale cached export, and success.
- Component tests verify blocking errors disable submission and warnings require acknowledgement where configured.
- Acceptance fixture exports the current analog-horror config and displays trigger/provenance/model identities.

**Acceptance criteria**

- Exporting does not start or allocate any GPU.
- User receives the exact `krea2-v1-<digest>.tar.gz` path and manifest summary.
- Changing one caption invalidates the cached export before submission.

### Milestone 2: storage and RunPod worker

#### RPT-008 - Implement ArtifactStore abstraction and RunPod network-volume S3 adapter

**Estimate:** 2 days
**Dependencies:** RPT-001, RPT-005
**Likely files:** `ui/src/server/artifacts/*`, `ui/src/helpers/remoteStorage.ts`, package dependencies, tests

**Outcome**

The controller can upload, head, range/download, list a bounded prefix, and checksum-verify artifacts without GPU compute.

**Implementation**

- Define a narrow `ArtifactStore` interface: `putImmutable`, `head`, `get`, `getRange` if supported, `listPage`, `exists`, and `deletePartial`.
- Implement RunPod's S3-compatible endpoint with explicit endpoint URL, path-style behavior as required, access ID/secret from environment, timeouts, bounded retries, and multipart upload where supported.
- Store metadata containing archive checksum, content digest, schema, byte length, and content type.
- Upload to a temporary key; verify remote size/checksum by read-back or provider-supported metadata; commit by writing the immutable digest key/ready marker.
- If the final digest key already exists with matching checksum, reuse it. If it conflicts, fail loudly rather than overwrite.
- Add resumable local downloads to `.part` with per-file hash validation and atomic rename.
- Limit prefix listing and paginate defensively; active reconciliation should read known indexes rather than recursively list the entire volume.

**Error handling and gotchas**

- S3 ETag is not a reliable SHA-256, especially for multipart uploads.
- S3-compatible behavior is a subset; do not assume AWS-specific checksum headers, object lock, lifecycle, or rename.
- Retry connection reset/408/429/5xx; do not retry authentication, invalid endpoint, or checksum conflict indefinitely.
- Two controllers uploading the same digest should converge on one identical immutable object.

**Tests**

- Contract tests run against an in-memory fake and an S3-compatible local test service.
- Interrupted multipart upload resumes or restarts without exposing a ready marker.
- 401/403/404/409/429/500/502/timeouts, truncated body, bad metadata, pagination, and concurrent identical uploads.
- Download never replaces a pre-existing verified local file with corrupt bytes.

**Acceptance criteria**

- A bundle can be uploaded and verified with no active RunPod GPU.
- Re-uploading identical content transfers zero or minimal bytes and returns the same object identity.
- No storage credential appears in a request log or Job record.

#### RPT-009 - Build a pinned, reproducible RunPod worker image

**Estimate:** 2 days
**Dependencies:** RPT-000, RPT-001
**Likely files:** `remote/runpod/Dockerfile`, `remote/runpod/requirements.lock`, `remote/runpod/handler.py`, `.github/workflows/build-runpod-worker.yml`, docs

**Outcome**

A Linux/amd64 CUDA image containing the exact fork can be built, scanned, tested locally, pushed, and referenced by digest.

**Implementation**

- Base on an explicit CUDA/Python image digest compatible with H100 and the pinned PyTorch build.
- Install OS and Python dependencies from pinned versions with hashes where tooling permits.
- Copy the committed AI Toolkit source and submodules at build time; do not `git pull` or `pip install -U` at startup.
- Add OCI labels for repository, Git commit, dirty=false, dependency-lock hash, CUDA, PyTorch, exporter schema versions, and build date.
- Use a non-root runtime user where GPU/runtime constraints allow; grant only the mounted run prefix and cache directories required.
- Add RunPod SDK startup fitness checks:
  - CUDA available and one supported GPU visible;
  - actual GPU is H100 for this endpoint policy;
  - mounted `/runpod-volume` is writable;
  - minimum free disk/volume space;
  - image labels and source commit agree;
  - Python imports and `run.py --help`/smoke initialization work.
- Set handler concurrency to one and refresh the worker after a training job to release leaked CUDA/process state.
- CI builds on each release tag/approved branch commit, runs CPU contract tests, scans image/dependencies, pushes an immutable tag, and records the registry digest.

**Error handling and gotchas**

- A tag such as `latest` is display-only. Endpoint and manifest must agree on the registry digest.
- Building Krea 2 dependencies on Windows does not validate Linux CUDA compatibility.
- Do not bake `HF_TOKEN`, RunPod keys, dataset content, or model weights into the image.
- Cold start may still be dominated by image pull and model download; model cache belongs on the volume and must be revision-keyed.

**Tests**

- Rebuild from the same source/lock and compare declared labels and dependency lock; document unavoidable layer timestamp differences if byte-identical OCI output is not achieved.
- Container starts with no GPU in test mode and fails the production fitness check clearly.
- Wrong Git commit label, absent mount, read-only mount, low disk, wrong GPU, missing Python package.
- Image secret scan and SBOM generation.

**Acceptance criteria**

- RunPod endpoint uses an image digest, not a mutable tag.
- Worker reports exact source/dependency/runtime identities before accepting training.
- A local container contract test handles a no-op fixture without external network access.

#### RPT-010 - Implement worker claim, safe bundle import, model cache, and private control DB

**Estimate:** 2.5 days
**Dependencies:** RPT-005, RPT-006, RPT-009
**Likely files:** `remote/runpod/handler.py`, `toolkit/remote/worker.py`, `toolkit/remote/control_db.py`, tests

**Outcome**

One and only one worker materializes a verified execution, and AI Toolkit can use its existing UI-trainer hooks against a worker-private database.

**Implementation**

- Validate the RunPod request schema before accessing storage.
- Atomically claim `executionId/requestKey` under its unique run prefix. A duplicate request with the same key attaches/returns existing state; a conflicting key for the same execution ID fails.
- Define a lease/heartbeat and stale-claim recovery rule. Only recover a stale claim when provider state and process checks prove no active owner.
- Copy or hard-link the immutable bundle into the run input, verify archive/content digests, and extract safely into a temporary work directory.
- Build a minimal private SQLite database with the exact Job columns queried/updated by `DiffusionTrainer`, insert the execution's Job row, and set config `sqlite_db_path` to it.
- Resolve path placeholders and verify the semantic config hash/transformation list.
- Download/cache the base model at the exact Hugging Face commit. Use a per-model revision lock, temporary cache directory, completed marker, and hash/revision verification so concurrent cold workers cannot share a partial snapshot.
- Refuse to use a stale or differently revised cache directory.
- Create the output tree only inside the execution prefix.

**Error handling and gotchas**

- Atomic `O_EXCL`/directory creation semantics on the mounted network filesystem must be verified in a real volume smoke test.
- Never modify the immutable bundle object or shared completed model snapshot.
- A worker killed during model download leaves no completion marker; the next worker removes or repairs only that revision's partial directory after acquiring the lock.
- The private DB is not synchronized live through S3. Control JSON is converted into DB flags by a worker-side watcher.

**Tests**

- Two handler processes race for one execution; only one launches the trainer.
- Duplicate identical request, conflicting request key, stale lease, active lease, orphaned process.
- Every malicious archive case from RPT-005 is rejected in the worker too.
- Private DB integration drives `stop`, `return_to_queue`, `save_now`, step, info, and speed fields through a fake trainer.
- Model cache cold download, cache hit, corrupt partial, revision mismatch, lock timeout, gated-token failure.

**Acceptance criteria**

- A retried RunPod request cannot launch duplicate gradient steps.
- Config points only to verified paths under the run/model roots.
- Worker reaches “ready to train” only after all identities verify.

#### RPT-011 - Run AI Toolkit and publish structured progress, logs, metrics, and heartbeats

**Estimate:** 3 days
**Dependencies:** RPT-010
**Likely files:** `toolkit/remote/runner.py`, `toolkit/remote/progress.py`, `remote/runpod/handler.py`, training hooks, tests

**Outcome**

The worker executes the unmodified semantic job config while exposing enough durable state for the local UI to behave like a local run.

**Implementation**

- Spawn `python -u run.py <resolved-config>` as a child process with `AITK_JOB_ID`, `AITK_JOB_OUTPUT_DIR`, `IS_AI_TOOLKIT_UI=1`, explicit `SEED`, and a minimal allowlisted environment.
- Capture stdout/stderr without blocking either pipe; append to local run log and rotate immutable log chunks by bounded byte size/time.
- Poll the private control DB for `step`, `total_steps`, `info`, `speed_string`, status, and flags; publish monotonic progress events and `runpod.serverless.progress_update` at a throttled cadence.
- Read new UILogger rows and emit immutable metric JSONL chunks. Use `(step,key)` as the natural idempotency key.
- Emit heartbeats during lengthy phases with no step movement: image/model download, model load, latent caching, sampling, saving, and final sync.
- Persist sanitized exception category, final lines, and traceback digest. Keep a full local remote log, redacted of environment and request secrets.
- Interpret child exit in conjunction with private DB status and control acknowledgement; exit code zero alone is not sufficient if finalization fails.
- Periodically inspect control objects. For `stop`, set the private DB stop flag and let `DiffusionTrainer.maybe_stop()` act between operations.
- Never parse the human console progress bar as the only source of step state.

**Error handling and gotchas**

- Pipe buffers can deadlock a verbose trainer if stdout/stderr are not drained concurrently.
- The trainer may spend many minutes loading/saving without step changes; heartbeat staleness thresholds must be phase-aware.
- A loss DB read while written must use SQLite read transactions/WAL semantics; exporter tracks last `(step,key)` and retries lock errors briefly.
- `progress_update` is an optimization, not durable state.
- Control polling should not interrupt the middle of `save()`; the existing trainer checks before/after save.

**Tests**

- Fake child emits interleaved stdout/stderr, CR progress bars, Unicode, large lines, partial UTF-8 chunks, then exits success/failure/signal.
- Private DB step/status changes produce ordered events; duplicates and regressions are rejected.
- Live metric extraction handles DB lock, update of existing metric, restart from cursor, and final flush.
- Heartbeat continues during a simulated long save and does not mislabel it hung.
- Secret canaries in environment and Axios/SDK exceptions never reach chunks or result.

**Acceptance criteria**

- A local fake worker run updates step/info/speed and loss points without direct access to the controller SQLite DB.
- Restarting the reconciler imports no duplicate log or metric chunk.
- A real short H100 smoke run displays progress before completion.

#### RPT-012 - Finalize immutable artifact catalog and atomic terminal result

**Estimate:** 2 days
**Dependencies:** RPT-011
**Likely files:** `toolkit/remote/artifacts.py`, `toolkit/remote/worker.py`, tests

**Outcome**

Partial files are distinguishable from verified checkpoints, and completion is committed atomically after all required artifacts are cataloged.

**Implementation**

- Watch output for completed samples, LoRA weights, optimizer/checkpoint state, resolved config, final loss DB, and logs.
- Treat files as stable only after producer close evidence or unchanged size/mtime across a safe interval plus successful open/hash. Prefer explicit training save hooks where available.
- Build immutable artifact-index generations containing path, role, step, size, SHA-256, media type, and required/optional flag.
- On success: stop readers, flush logs/metrics, close the trainer/private DB, hash final required files, write `result.json`, fsync, then write `COMPLETE` last.
- On safe stop: catalog the last completed checkpoint, write `result.json` with `stopped` and `resumeCandidate`, then a `STOPPED` marker.
- On failure/cancel: preserve verified prior checkpoints and partial diagnostics; never mark an in-progress checkpoint complete.
- Return only a small RunPod result containing execution ID, terminal status, run prefix, result hash, and final step.

**Error handling and gotchas**

- AI Toolkit may delete older checkpoints due to `max_step_saves_to_keep`; artifact indexing must process deletions and never advertise a missing resume candidate.
- A `.safetensors` filename appearing is not proof its writer is closed.
- Final RunPod API result may expire; the volume marker/result is durable authority.
- Hashing very large optimizer state can take time and needs heartbeats.

**Tests**

- File grows while scanner runs; it is not indexed until stable/closed.
- Worker dies before `COMPLETE`; controller treats run as partial even if weights exist.
- Success, graceful stop, forced cancel during training, force kill during save, disk full during finalization.
- Artifact index restart and generation monotonicity.

**Acceptance criteria**

- Controller can identify the latest verified LoRA/checkpoint without directory heuristics.
- `COMPLETE` is never present before all required result hashes verify.
- A simulated crash cannot replace a prior valid checkpoint with a partial file.

### Milestone 3: controller, queue, and synchronization

#### RPT-013 - Add typed RunPod Serverless client and connection preflight

**Estimate:** 2 days
**Dependencies:** RPT-000, RPT-001, RPT-008
**Likely files:** `ui/src/server/remote/runpodClient.ts`, `ui/src/server/remote/runpodSettings.ts`, `ui/src/app/api/settings/providers/runpod/test/route.ts`, tests

**Outcome**

The local server can authenticate, inspect endpoint health/configuration, submit, poll, and cancel through a bounded, redacted client.

**Implementation**

- Implement direct REST calls or a pinned SDK behind a `RemoteComputeClient` interface with `submit`, `status`, `cancel`, `health`, and optional request lookup.
- Resolve `RUNPOD_API_KEY` from environment only for MVP. Resolve endpoint ID, network-volume storage endpoint, volume ID, and expected worker digest from environment or non-secret Settings.
- Apply connect/read/overall timeouts, retry only safe idempotent operations, honor 429 metadata, and use exponential backoff with full jitter.
- Parse provider responses through schemas. Normalize RunPod states to the internal taxonomy without treating unknown states as success.
- Test connection by checking endpoint access/health and storage access without starting a GPU worker. Report workersMin/max, GPU priorities, network volume, timeouts, and whether configuration matches policy.
- Block submission if active workers are nonzero, max workers exceeds the configured cost ceiling, H100 is not the sole accepted GPU for strict mode, the volume is missing/mismatched, or endpoint image digest cannot be established.
- Permit an explicit warning-only mode for harmless differences, but never silently accept a fallback GPU or mutable image.

**Error handling and gotchas**

- A health check may not reveal the exact image digest; if RunPod cannot report it, require the configured expected digest and have the worker enforce it again.
- Endpoint automatic scale-down after inactivity can reduce max workers to zero. Preflight should explain this specific fix.
- POST `/run` is not safely retryable after an ambiguous connection failure unless idempotency is proven by provider lookup/worker claim.
- Never log Axios request config wholesale.

**Tests**

- Mock RunPod responses for every documented job state plus unknown state, malformed JSON, HTML proxy error, empty body, rate limit, timeout, and auth failure.
- Preflight policy tests for workersMin 1, max 0/1/2, H100 plus fallback GPU, wrong volume, wrong endpoint, missing digest, and healthy configuration.
- Retry test proves GET status retries and ambiguous POST does not auto-resubmit.
- Redaction test uses fake secret in headers, URL, nested cause, and response config.

**Acceptance criteria**

- **Test RunPod connection** validates configuration without allocating a GPU.
- Submission cannot proceed if zero-idle/cost/identity safeguards do not hold.
- The API key never reaches browser JSON or logs.

#### RPT-014 - Dispatch remote jobs idempotently from the existing queue

**Estimate:** 2.5 days
**Dependencies:** RPT-002, RPT-007, RPT-008, RPT-013
**Likely files:** `ui/cron/actions/startJob.ts`, `ui/cron/actions/processQueue.ts`, `ui/cron/actions/startRemoteJob.ts`, `ui/src/server/remote/dispatcher.ts`, tests

**Outcome**

A queued RunPod Job exports/reuses its bundle, uploads it, creates one durable attempt, and receives one provider job ID without affecting local dispatch.

**Implementation**

- Refactor `startJob` into a thin backend dispatcher: existing local code moves unchanged to `startLocalJob`; RunPod code lives in `startRemoteJob`.
- Use `execution_target` to select backend and namespaced `runpod:h100` as the queue key.
- Claim the Job/RemoteExecution transactionally before validation or network side effects.
- Recheck the cached bundle fingerprint. Export if absent/stale, upload immutably, then persist bundle object identity before submission.
- Compute stable `request_key` from Job ID, attempt, bundle content digest, canonical config digest, worker image digest, and execution policy.
- Persist `submission_started_at` and nonce before POST. Persist provider job ID immediately after a valid response.
- On ambiguous submission, move to `submission_unknown`; do not release the queue or submit again automatically. Reconcile provider request listing and the durable worker claim if supported.
- Queue remains occupied while the remote execution is active or uncertain. It releases only after terminal state/safe explicit abandonment.
- Remote preparation uses CPU/network locally and must not reserve the RTX 5090.

**Error handling and gotchas**

- The current code sets Job `running` before asynchronous spawn. Preserve that compatibility projection but use `info` and RemoteExecution state to expose preparation/queue phases.
- Two cron workers can race. A database compare-and-set must decide ownership before any upload/POST.
- If upload succeeds but submission fails safely, reuse the immutable bundle on the next user-initiated attempt.
- If POST succeeds but response is lost, worker-side idempotency prevents duplicate training, but cost can still be incurred by duplicate queued requests; hence no blind retry.

**Tests**

- Local Job takes exactly the old path and spawns Python with unchanged arguments/environment.
- Remote Job never calls local spawn or sets CUDA visibility locally.
- Two concurrent dispatchers, duplicate queue ticks, app restart during export/upload/after POST, upload success + submit failure, ambiguous submit, provider 409-equivalent.
- Cached bundle reuse and stale-caption invalidation.

**Acceptance criteria**

- One UI click produces at most one logical remote training execution.
- Local GPU remains available during remote preparation/training.
- Restart at every dispatch boundary converges without duplicate gradient work.

#### RPT-015 - Reconcile remote state and mirror artifacts into the existing output tree

**Estimate:** 3 days
**Dependencies:** RPT-011, RPT-012, RPT-014
**Likely files:** `ui/cron/actions/reconcileRemoteExecutions.ts`, `ui/src/server/remote/artifactSync.ts`, `ui/src/server/remote/metricImporter.ts`, cron worker, tests

**Outcome**

The existing job page shows remote progress and artifacts, including after controller/browser restarts or provider result expiry.

**Implementation**

- Run reconciliation before queue dispatch in each cron loop, protected by the existing non-overlap guard and per-execution leases.
- Poll cadence by state: fast while running, slower while queued, exponential/backed-off during provider errors, and one final verification for terminal runs.
- Merge provider state and durable state using explicit precedence. Never regress a higher event sequence or overwrite verified success with an expired/404 API response.
- Update Job `step`, `total_steps`, `info`, `speed_string`, `status`, and stop flag projection transactionally with RemoteExecution cursor/state.
- Download unseen log chunks and append exactly once to local `output/<job>/log.txt`. Persist log cursor before/after append with crash-safe reconciliation.
- Import metric chunks idempotently into a local `loss_log.db` matching `UILogger` schema, so the existing loss endpoint/graph needs no remote branch.
- Download sample artifacts on discovery and all required final LoRA/checkpoint artifacts at terminalization. Use `.part`, checksum, fsync/close, then atomic rename.
- Write a local `.remote_execution.json` provenance file and keep remote-resolved config/result manifests.
- If the local output folder already contains another execution, namespace raw mirrored data under `.remote/<execution-id>/` and expose only verified selected artifacts at the compatibility paths. Never overwrite same-name/different-hash files.
- After RunPod result retention expires, reconcile from `state/current.json`, artifact index, and terminal marker.

**Error handling and gotchas**

- Crash between appending log bytes and saving cursor can duplicate text. Make chunks self-identifying and maintain an applied-chunk journal; append only after checking it.
- Do not poll/list recursively; fetch known index/state keys.
- A sample may be displayed while the run continues; checksum and atomic rename first.
- Local disk full should not mark remote training failed. Set artifact sync error and preserve remote success.
- Network outage should mark state stale, not terminal failure, while provider/volume authority may recover.

**Tests**

- Out-of-order/duplicate progress, stale heartbeat, provider 404 with durable completed result, provider completed before `COMPLETE`, and conflicting failed/completed signals.
- Reconciler restart at each cursor update boundary produces no duplicate logs/metrics or corrupt files.
- Interrupted/truncated/corrupt artifact downloads, local name collision, disk full, permissions error, deleted remote optional sample.
- Existing `/log`, `/loss`, `/samples`, and `/files` route tests work against mirrored fixtures.

**Acceptance criteria**

- Close browser/app, restart it during a run, and see current progress without manual repair.
- Loss graph and samples use existing UI components and match remote artifacts.
- Completed LoRA files are present locally with verified hashes and can be selected in ComfyUI.

#### RPT-016 - Add checkpoint-safe stop with forced-cancel escalation

**Estimate:** 2 days
**Dependencies:** RPT-010, RPT-011, RPT-013, RPT-015
**Likely files:** stop route, remote controller, control schema, `JobActionBar.tsx`, tests

**Outcome**

The normal Stop action asks AI Toolkit to stop between unsafe operations and preserves the last completed checkpoint; force cancel is explicit and exceptional.

**Implementation**

- Dispatch stop by execution target. Local PID behavior remains unchanged.
- Remote safe stop writes a monotonic immutable control request object and sets `stop_requested_at`; it does not immediately call `/cancel`.
- Worker control watcher validates the request, sets private DB `stop=1`, writes acknowledgement, and allows `DiffusionTrainer.maybe_stop()` to exit at its normal hooks.
- UI shows `Stop requested`, current phase, last verified checkpoint, and elapsed grace time.
- Define phase-aware grace limits. Loading/training can acknowledge quickly; saving gets a longer limit and a warning not to interrupt.
- After grace expiry, offer **Force cancel RunPod worker** with explicit corruption warning and latest safe checkpoint. Force action calls `/cancel` once and records the provider response.
- A queued-not-started job can be cancelled immediately because no checkpoint write exists.
- Reconciliation treats stopped/cancelled separately from failure and downloads the last verified resume candidate.

**Error handling and gotchas**

- Do not write directly to the live private SQLite file through S3.
- A control object can arrive twice/out of order; sequence/idempotency rules apply.
- Provider `/cancel` returns immediately; continue reconciling durable state/artifacts until terminal or timeout.
- Deleting a Job while a worker runs must first complete stop/force-cancel flow or require a second dangerous confirmation.

**Tests**

- Stop while queued, model loading, training, sampling, before save, during save, after completion, and during controller outage.
- Duplicate stop clicks and force-cancel clicks call provider at most once.
- Simulated trainer acknowledges only after save and preserves prior checkpoint.
- Stop control secret/path tampering is rejected.

**Acceptance criteria**

- Normal stop never interrupts a simulated checkpoint write.
- UI distinguishes safe stopped from forced cancelled.
- Last verified checkpoint remains downloadable/resumable.

#### RPT-017 - Implement explicit resume/continue as a new attempt

**Estimate:** 3 days
**Dependencies:** RPT-012, RPT-015, RPT-016
**Likely files:** `ui/src/server/remote/resume.ts`, job action/API, worker restore logic, tests

**Outcome**

A user can add steps or recover an interrupted run from a specific verified checkpoint without mutating the historical attempt.

**Implementation**

- Add **Continue training** action that selects a verified `resumeCandidate` and creates a new RemoteExecution attempt.
- Store parent execution ID, checkpoint artifact digest, original bundle digest, original config digest, prior target step, and new target step.
- Treat `train.steps` as the final desired total, matching AI Toolkit semantics; UI “500 more” computes and displays the resulting total explicitly.
- Worker restores only the complete set of files AI Toolkit requires for optimizer/scheduler/RNG/model resume. Determine this set through a repository-level checkpoint inventory spike and codify it in the artifact schema.
- Verify every restored file and place it into the exact execution output layout AI Toolkit expects before launch.
- Keep the original config identical except explicitly approved fields such as final total steps and save/sample cadence. Record semantic diff in the new manifest/result.
- Support remote-to-remote first. Local-to-remote resume is enabled only after its local checkpoint inventory passes the same validation. Remote-to-local can be documented once mirrored state is complete.

**Error handling and gotchas**

- A LoRA `.safetensors` alone may be insufficient for optimizer-exact resume.
- Changing optimizer, rank, architecture, precision, dataset, repeats, or model revision invalidates exact resume; require a new training experiment instead.
- The latest filename may be partial; only artifact-indexed completed checkpoints are selectable.
- Cross-GPU resume is provenance-equivalent, not bitwise deterministic.

**Tests**

- Resume from steps 500/1000/2000 to a higher final total and verify first new optimizer step/step numbering.
- Missing optimizer file, hash mismatch, partial checkpoint, incompatible config diff, changed dataset, changed base revision.
- Duplicate resume request creates one new attempt.
- End-to-end short local fixture compares uninterrupted N steps with stop/resume to N steps within the documented tolerance where deterministic mode permits.

**Acceptance criteria**

- “500 more steps” from a completed 2000-step run submits a 2500-total-step attempt and starts from the selected 2000 checkpoint.
- Parent artifacts remain immutable and visible.
- Incompatible resume is blocked before GPU allocation.

### Milestone 4: UI and operational safety

#### RPT-018 - Add RunPod settings, execution-target selector, and preflight review

**Estimate:** 2 days
**Dependencies:** RPT-007, RPT-013, RPT-014
**Likely files:** `ui/src/app/settings/page.tsx`, settings routes/helpers, `SimpleJob.tsx`, `jobConfig.ts`, components/tests

**Outcome**

Users can configure non-secret RunPod identifiers, see secret status, select RunPod H100, and review exact immutable inputs before queueing.

**Implementation**

- Settings fields: endpoint ID, network volume ID, S3 endpoint, expected worker image digest, execution timeout, TTL, and local artifact/bundle folders.
- Secret fields show environment-only configured status and variable names; no “save key locally” for RunPod MVP.
- Add **Test connection** with policy report and no GPU allocation.
- Add execution target selector to training Job creation: Local GPU (default) or RunPod H100.
- When RunPod is selected, hide/disable local GPU ID without removing it from the saved local configuration; set `execution_target` separately.
- Pre-submit modal displays image/caption counts, warnings, content/archive hashes, model commit, source/worker commit, H100-only policy, timeouts, archive size, and estimated maximum active-runtime charge based on a configurable displayed rate timestamp.
- Require acknowledgement that estimates exclude storage, cold start, queue behavior, and price changes. Fetch current price only if a reliable official API exists; otherwise label configuration as user-supplied and link to pricing.
- Disable submit on stale export, failed connection, missing provenance, mutable image, dirty code mismatch, or invalid timeouts.

**Error handling and gotchas**

- Price is mutable and cannot be hard-coded as a billing guarantee.
- RunPod automatic endpoint inactivity scale-down can set max workers to zero; test connection should identify it.
- Editing the Job after preflight invalidates the confirmation token/hash.

**Tests**

- Component tests for default local target, toggling target, secret configured statuses, every blocking preflight reason, warning acknowledgement, and stale confirmation.
- API tests prove browser payload never contains secret values.
- Accessibility: keyboard navigation, labels, focus on first error, screen-reader status updates.

**Acceptance criteria**

- Existing users see Local GPU selected and no changed training fields.
- A valid RunPod job can be queued only after a fresh immutable preflight.
- No UI field can reveal or round-trip the API/storage secret.

#### RPT-019 - Extend job detail/actions for remote lifecycle and artifact provenance

**Estimate:** 2 days
**Dependencies:** RPT-015, RPT-016, RPT-017
**Likely files:** `JobOverview.tsx`, `JobActionBar.tsx`, job page/hooks, new remote execution components/tests

**Outcome**

The job page clearly shows where work runs, what it costs/uses, current provider state, artifacts, and safe actions.

**Implementation**

- Add a remote execution panel with attempt, RunPod job ID (copyable), requested/actual GPU, queue/cold-start/run/sync durations, heartbeat age, bundle/model/image digests, and source commit.
- Render granular phases and distinguish provider queue from local AI Toolkit queue.
- Keep existing progress bar, log terminal, loss graph, samples, and files panels backed by mirrored local files.
- Add actions based on state: safe stop, force cancel after grace, retry artifact sync, continue from checkpoint, reveal local artifact, copy remote provenance, and open RunPod console link.
- Disable local-only **Save Next Step** and **Sample Next Step** until remote control commands are implemented; do not present non-working buttons.
- Show a persistent “results are still remote” state until required artifacts verify locally.
- Terminal errors show normalized code, concise remediation, and expandable redacted diagnostics.

**Error handling and gotchas**

- `actual_gpu` is worker-attested informational data; requested H100 mismatch is a terminal policy violation.
- Heartbeat warnings must be phase-aware and not panic during a long known save.
- Never render raw provider HTML/error bodies.

**Tests**

- Component state matrix for queued, cold start, loading, caching, training, sampling, saving, stop requested, forced cancel, syncing, completed, failed, stale, and lost.
- Existing local and cloud-caption Job views remain unchanged.
- Action authorization tests prevent stop/resume/delete races.

**Acceptance criteria**

- A user can understand whether waiting time is local queue, RunPod queue, cold start, training, or download.
- Final files and their hashes are discoverable from the job page.
- No remote-only action is shown when it cannot succeed.

#### RPT-020 - Preserve local-job behavior and separate remote queue resources

**Estimate:** 1.5 days
**Dependencies:** RPT-014, RPT-018, RPT-019
**Likely files:** queue helpers, job action helpers, queue/job UI, regression tests

**Outcome**

Remote work neither blocks the local 5090 queue nor changes existing local/caption semantics.

**Implementation**

- Give `runpod:h100` its own Queue row and human label.
- Ensure RunPod queue execution does not query/occupy local GPU telemetry or set `CUDA_VISIBLE_DEVICES` on the controller.
- Keep cloud caption queue (`cloud`) independent from both local training and RunPod training.
- Audit `getAvailableJobActions`, queue start/stop, active widget, dashboard grouping, clone/edit, and macOS GPU rewriting for namespaced targets.
- Allow one local training, one cloud caption run, and one remote RunPod preparation/run concurrently within their own limits.
- Add a feature flag `AI_TOOLKIT_RUNPOD_ENABLED=1`; disabled mode hides UI and rejects forged remote API requests while local paths remain identical.

**Error handling and gotchas**

- Current Queue identifies resources through `gpu_ids`; exact string comparisons for `cloud`/`mps` exist in several components and must be audited.
- Stopping the RunPod queue should request safe stop for active remote work if current queue semantics do so; clarify UI copy because stopping new dispatch versus stopping current work are different actions.

**Tests**

- Queue scheduler has jobs for GPU `0`, `cloud`, and `runpod:h100`; all eligible jobs progress independently and never cross-dispatch.
- Feature flag off: remote route 404/disabled, local snapshot behavior unchanged.
- macOS test leaves `runpod:h100` intact and only maps local GPU to `mps`.

**Acceptance criteria**

- Training remotely leaves the 5090 available for a local job.
- Captioning can run while either training backend is active.
- Full existing local test suite passes with the feature disabled and enabled.

### Milestone 5: optional archive, test harness, and rollout

#### RPT-021 - Add optional AWS S3 immutable archive adapter

**Estimate:** 2 days
**Dependencies:** RPT-008, RPT-012
**Likely files:** `ui/src/server/artifacts/awsS3Store.ts`, settings/docs/tests

**Outcome**

Bundles and final results can be retained independently of RunPod without giving RunPod long-lived AWS credentials.

**Implementation**

- Implement the same ArtifactStore contract with the AWS SDK default credential chain.
- Allow local use of `AWS_PROFILE=echoflicks`; save the profile name as non-secret configuration, never copy credential/config files.
- Archive immutable bundle, manifest, result, artifact index, LoRA/checkpoint outputs, and provenance under content-addressed keys.
- Enable bucket versioning/encryption/lifecycle through documented infrastructure steps, not implicit destructive API calls.
- Local controller performs archive upload after RunPod completion. Worker direct-to-AWS transfer is deferred.
- If future direct worker access is needed, use bounded presigned URLs or STS credentials with prefix-scoped permissions and expiration. AWS CLI [presigned URLs](https://docs.aws.amazon.com/cli/latest/reference/s3/presign.html) expire in at most seven days; [temporary credentials](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_use-resources.html) must be refreshed before expiration.
- Archive failure does not change a verified RunPod training success; it is a separate retryable sync state.

**Error handling and gotchas**

- Do not shell out to `aws s3 sync` from the UI with user-supplied paths/arguments.
- Bucket name/region/key prefix are not secrets, but signed URLs and session tokens are.
- Multipart ETags are not content digests; verify SHA-256 metadata/read-back.
- Lifecycle rules must never expire the only resume checkpoint before the configured retention window.

**Tests**

- AWS adapter contract tests with a fake/local S3 service.
- Profile missing, expired SSO/session, access denied, wrong region, KMS denied, multipart interruption, checksum mismatch, versioned existing object.
- No AWS credential value enters worker request/bundle/log.

**Acceptance criteria**

- With `AWS_PROFILE=echoflicks`, a local opt-in archive succeeds without a GPU and verifies hashes.
- With AWS unavailable, RunPod completion remains completed and UI offers archive retry.
- RunPod receives no AWS profile files or long-lived credentials.

#### RPT-022 - Build fake RunPod/S3 services and full controller-worker contract tests

**Estimate:** 3 days
**Dependencies:** RPT-008 through RPT-020
**Likely files:** `testing/remote/`, `ui/src/server/remote/*.test.ts`, Docker Compose/test scripts, CI workflow

**Outcome**

Nearly all remote logic, including restarts and failures, is deterministic and testable without paid GPU time.

**Implementation**

- Add a fake RunPod HTTP server implementing `/run`, `/status`, `/cancel`, health, configurable delays/errors, result expiry, and ambiguous submission.
- Add an S3-compatible local service or in-memory contract implementation with fault injection.
- Add a fake worker/trainer that writes private DB progress, logs, metrics, samples, checkpoints, and terminal markers using the production contracts.
- Provide a test clock, deterministic jitter, and crash points after every important side effect.
- Run a real Next.js/cron worker plus test database and exercise API/UI-facing state end to end.
- Keep paid H100 tests excluded from normal CI and explicitly opt-in.

**Error handling and gotchas**

- Mocks must not make POST submission look idempotent unless the production mechanism proves it.
- Test both RunPod API truth and durable volume truth disagreement.
- Windows CI/path behavior and Linux container extraction both matter.

**Tests**

- The full acceptance matrix in Section 12.
- Property tests for event ordering/idempotency and bundle path normalization.
- Long-log/large-metric performance test with bounded memory.
- Controller process killed/restarted at each dispatch/reconcile/finalization checkpoint.

**Acceptance criteria**

- One command runs the no-cost remote integration suite locally.
- CI proves duplicate dispatch, torn artifacts, stale events, and secret leakage are prevented.
- Paid smoke tests are not required for ordinary contributor PRs.

#### RPT-023 - Real H100 smoke test, observability, documentation, and staged rollout

**Estimate:** 2.5 days plus RunPod time
**Dependencies:** RPT-000 through RPT-022
**Likely files:** docs, runbooks, release notes, CI/manual test checklist

**Outcome**

The feature is proven on a real zero-active-worker H100 endpoint and can be operated/recovered by someone other than its implementer.

**Implementation**

- Create/configure one queue-based endpoint from the pinned worker image and one network volume in a data center with H100 availability.
- Set zero active workers, one maximum worker, one H100, concurrency one, short idle timeout, explicit execution timeout/TTL, and required endpoint secrets.
- Run a tiny non-production fixture first, then a bounded Krea 2 Raw smoke job with small steps/save/sample intervals.
- Capture queue delay, cold start, model cache miss/hit, step speed, GPU identity, stop behavior, final sync, and scale-to-zero evidence.
- Verify the second run reuses model/bundle cache without sharing mutable execution files.
- Add structured local logs for dispatch/reconcile transitions with execution ID/request ID but no secrets.
- Write setup, credential rotation, endpoint inactivity scale-down, H100-capacity waiting, stale execution, artifact recovery, force-cancel, volume cleanup, and ComfyUI-use runbooks.
- Roll out behind the feature flag: developer only, one trusted user, then default-visible after evidence.

**Error handling and gotchas**

- Do not use the full analog-horror 2000-step job as the first paid test.
- Validate RunPod billing/worker scale-down in the console after every early smoke run.
- Network volume persistence incurs storage cost even with zero GPU workers; document cleanup/retention.

**Tests**

- Execute all P0/P1 acceptance cases feasible on real infrastructure: cold start, cache hit, progress, controller restart, safe stop, resume, result retention recovery, and final download.
- Verify a forced bad checksum fails before model load/training.
- Verify an H100-only mismatch test using a test endpoint/config fails closed.
- Manually inspect secret scan and generated bundle.

**Acceptance criteria**

- A real H100 run starts from the local UI, shows live progress/loss/samples, completes, downloads a verified LoRA, and the endpoint returns to zero active workers.
- A controller restart does not lose or duplicate the run.
- Documentation lets a clean machine configure and test the feature without reading source code.

#### RPT-024 - Optional phase 2: ephemeral RunPod Pod backend

**Estimate:** 4-6 days
**Dependencies:** Stable Serverless implementation and measured cost data
**Status:** Deferred

**Outcome**

Users who accept more orchestration complexity can choose a lower active-hour Pod rate while retaining the same bundle/UI/artifact contracts.

**Implementation direction**

- Implement `RemoteComputeClient` with RunPod Pod create/get/stop/delete APIs.
- Boot the same pinned worker image with one execution ID and volume.
- Add an independent watchdog with terminate-after deadline, plus controller reconciliation that deletes terminal/orphaned Pods.
- Require deletion confirmation from RunPod and surface any still-billable resource prominently.
- Preserve the worker request/claim/state/artifact contracts so only infrastructure lifecycle differs.
- Compare measured total cost including startup, storage, orphan risk, and engineering overhead before recommending it over Serverless.

**Gate**

Do not start this ticket until Serverless is reliable and at least five representative training runs provide duration/cost data. A cheaper hourly price alone does not justify orphaned-GPU risk.

## 11. Unit and contract test matrix

The ticket-level tests above are mandatory. This matrix is the release-level inventory and names the boundary each suite protects.

### Python: bundle and configuration

| ID     | Test                                                          | Expected result                                       |
| ------ | ------------------------------------------------------------- | ----------------------------------------------------- |
| PY-B01 | Clean JPEG/PNG/WebP pairs with UTF-8 captions                 | Valid report and stable file inventory                |
| PY-B02 | Missing, empty, whitespace-only, invalid UTF-8 caption        | Blocking error naming the exact image                 |
| PY-B03 | Caption contains structured Gemini refusal/failure record     | Blocking error; text is not exported as caption       |
| PY-B04 | Legitimate visible text includes “error”                      | Not rejected by naive substring rule                  |
| PY-B05 | Duplicate stem across `.jpg`/`.png`                           | Blocking ambiguous-sidecar error                      |
| PY-B06 | Case-fold and Unicode-normalization filename collisions       | Blocking portability error on every OS                |
| PY-B07 | Corrupt image, wrong magic/extension, huge dimensions         | Blocking typed image-validation error                 |
| PY-B08 | Symlink, junction, FIFO, device, socket                       | Blocking unsafe-file error; target never read         |
| PY-B09 | File mutates between preflight and archive stream             | Export aborts; no final archive                       |
| PY-B10 | `[trigger]`, literal trigger, duplicate/missing/mixed trigger | Accurate coverage and policy severity                 |
| PY-B11 | Caption provenance exact match/stale/missing/partial          | Pass or explicit block with remediation               |
| PY-B12 | Dataset cache/metadata files                                  | Excluded without entering manifest                    |
| PY-B13 | Windows drive/UNC paths in every registered config field      | Replaced by typed placeholders                        |
| PY-B14 | Placeholder-like text inside prompt/caption                   | Preserved as content                                  |
| PY-B15 | Config round trip                                             | No semantic diff except recorded path transformations |
| PY-B16 | Resolve mutable HF revision                                   | Records immutable commit; token never serialized      |
| PY-B17 | Same recorded export under two host roots                     | Equal content and archive digests                     |
| PY-B18 | One-byte image/caption/config/provenance change               | Content/archive identity changes                      |
| PY-B19 | Malicious tar traversal/absolute/drive/ADS path               | Rejected before extraction                            |
| PY-B20 | Tar symlink/hardlink/device/duplicate/unlisted member         | Rejected before extraction                            |
| PY-B21 | Declared and actual decompression limit                       | Abort with bounded disk/memory use                    |
| PY-B22 | Disk full/short write/interruption                            | Only partial artifact remains; final name absent      |

### Python: worker and trainer bridge

| ID     | Test                                                          | Expected result                                             |
| ------ | ------------------------------------------------------------- | ----------------------------------------------------------- |
| PY-W01 | Two workers claim one execution simultaneously                | One trainer starts; duplicate attaches/exits                |
| PY-W02 | Same execution ID with different request key                  | Conflict, no trainer start                                  |
| PY-W03 | Stale lease with no active process vs live lease              | Recover only the proven stale claim                         |
| PY-W04 | Worker image/source/dependency digest mismatch                | Fail before model or dataset load                           |
| PY-W05 | Model cache miss/hit/corrupt partial/revision mismatch        | Safe lock, exact snapshot, no partial reuse                 |
| PY-W06 | Private DB schema with real DiffusionTrainer query/update set | All UI hooks operate without local DB                       |
| PY-W07 | Interleaved large stdout/stderr and partial UTF-8             | No deadlock; exact ordered sanitized chunks                 |
| PY-W08 | Step/info/speed status changes                                | Monotonic structured progress                               |
| PY-W09 | Long model load/sample/save                                   | Heartbeat continues without false hang                      |
| PY-W10 | Live loss DB locked/restarted/updated                         | Idempotent metric chunks with no missing points             |
| PY-W11 | Stop request before/during/after save                         | DB flag set; trainer exits only at safe hook                |
| PY-W12 | Duplicate/out-of-order control requests                       | Apply once in sequence order                                |
| PY-W13 | Child exit zero but finalization fails                        | Remote execution fails/sync-incomplete, not completed       |
| PY-W14 | Child exception/OOM/signal                                    | Stable error taxonomy and verified old checkpoints retained |
| PY-W15 | File visible while still growing                              | Not cataloged as a completed artifact                       |
| PY-W16 | Crash before terminal marker                                  | Partial run; never completed                                |
| PY-W17 | Success finalization                                          | Result/index hashes verify before `COMPLETE`                |
| PY-W18 | Secret canaries in env/request/error                          | Absent from logs, events, result, artifacts                 |

### TypeScript: settings, RunPod client, persistence, and scheduler

| ID     | Test                                                             | Expected result                                  |
| ------ | ---------------------------------------------------------------- | ------------------------------------------------ |
| TS-C01 | GET settings with configured RunPod secrets                      | Only boolean/source status returned              |
| TS-C02 | Nested provider error contains bearer/storage secrets            | Sanitized normalized error                       |
| TS-C03 | Healthy endpoint with zero min/one max/H100/volume               | Preflight passes without GPU start               |
| TS-C04 | Min workers >0, max workers >1, GPU fallback, wrong volume/image | Preflight blocks with exact policy issue         |
| TS-C05 | RunPod documented and unknown states                             | Stable mapping; unknown never equals success     |
| TS-C06 | GET 429/5xx/timeouts                                             | Bounded retry with deterministic injected jitter |
| TS-C07 | POST response timeout after request write                        | `submission_unknown`; no automatic POST retry    |
| TS-C08 | State transition matrix                                          | Invalid regressions rejected                     |
| TS-C09 | Concurrent execution attempt/dispatch claims                     | One winner and one provider submission           |
| TS-C10 | App restart before upload/during upload/before POST/after POST   | Converges without duplicate training             |
| TS-C11 | Local, cloud caption, RunPod queue together                      | Independent dispatch and resource isolation      |
| TS-C12 | Feature flag disabled                                            | Forged remote request rejected; local unchanged  |
| TS-C13 | macOS target mapping                                             | Local -> `mps`; RunPod key unchanged             |
| TS-C14 | Cached export source fingerprint stale                           | Submission blocked and re-export required        |
| TS-C15 | Existing bundle object with same/different hash                  | Reuse same; fail conflict                        |

### TypeScript: reconciler, artifacts, and UI

| ID     | Test                                                  | Expected result                                        |
| ------ | ----------------------------------------------------- | ------------------------------------------------------ |
| TS-R01 | Duplicate/out-of-order progress sequence              | Applied exactly once, no step regression               |
| TS-R02 | Provider completed but marker absent                  | Stay finalizing/syncing, not completed                 |
| TS-R03 | Provider result expired; durable `COMPLETE` valid     | Recover and complete from volume                       |
| TS-R04 | Provider failed but durable verified completion later | Apply documented precedence and record conflict        |
| TS-R05 | Controller crash around log append/cursor commit      | No duplicate/missing chunk after restart               |
| TS-R06 | Metric chunk replay                                   | Same `(step,key)` values, no duplicates                |
| TS-R07 | Truncated/corrupt download                            | `.part` retained/retried; valid local file untouched   |
| TS-R08 | Same filename with different local hash               | Preserve both under execution namespace; flag conflict |
| TS-R09 | Local disk full/permission failure                    | Remote success retained; sync state error/retry        |
| TS-R10 | Stale heartbeat in loading/training/saving            | Phase-aware UI warning, no automatic failure           |
| TS-R11 | Safe stop and force cancel repeated clicks            | One control request and at most one `/cancel`          |
| TS-R12 | Continue 500 more from step 2000                      | New attempt total is 2500, parent immutable            |
| TS-R13 | Resume incompatible config/checkpoint                 | Block before submission                                |
| TS-R14 | Job detail state/action matrix                        | Only valid actions visible/enabled                     |
| TS-R15 | Existing log/loss/sample/files APIs on mirror         | Same response shape as local run                       |
| TS-R16 | Delete remote-backed local job                        | Explicit remote-retention notice; no remote purge      |

### Storage adapter contract

Every ArtifactStore implementation must pass the same suite:

1. Put and read an immutable object.
2. Re-put identical bytes idempotently.
3. Reject same key/different bytes.
4. Verify size and SHA-256 independently of ETag.
5. Resume or safely restart interrupted multipart upload.
6. Download to `.part`, checksum, and atomically rename.
7. Paginate with deterministic ordering and a hard maximum.
8. Distinguish not-found, auth, rate limit, transient server error, checksum conflict, and local I/O failure.
9. Never delete a final object when cleaning a partial upload.
10. Never log credentials or signed query parameters.

### Test data policy

- Keep a tiny redistributable image/caption fixture in the repository.
- Do not commit the user's analog-horror source images, Gemini key, RunPod key, HF token, AWS credentials, model weights, or large generated checkpoints.
- Real Krea 2/H100 tests reference a locally configured private dataset and are opt-in.
- Golden manifests use fake repository/model commits with valid formats unless the test explicitly resolves live metadata.

## 12. End-to-end acceptance test matrix

### A. Export and local parity

**AT-01 - Clean bundle export**

Given a clean image/caption dataset and the last Krea 2 Raw style template, exporting produces `krea2-v1-<digest>.tar.gz`, `train.template.yaml`, and `manifest.json`; all member hashes verify.

**AT-02 - Validation blocks paid work**

Given one empty caption, one Gemini refusal, one duplicate stem, and one unsupported image, preflight reports all four and makes zero RunPod/storage submit calls.

**AT-03 - Trigger correctness**

Given configured trigger `nightmarish analog broadcast style`, the manifest reports resolved coverage and the worker-resolved captions match local trainer replacement semantics without duplicate injection.

**AT-04 - Gemini provenance**

After recaptioning, manifest records exact provider, model, template/prompt hash, timestamp, and zero failures. Editing one caption makes provenance stale and blocks strict export.

**AT-05 - Path portability**

Export from the current Windows paths, import in Linux container, and prove no host absolute path remains and all non-path config fields match.

**AT-06 - Local bundle smoke**

Run a tiny exported fixture locally through the worker materializer and reach a valid checkpoint/result without RunPod.

### B. Submission and cost safeguards

**AT-07 - Zero-idle preflight**

Endpoint with `workersMin=0`, `workersMax=1`, one H100, expected image, and correct volume passes. Changing any required value blocks submission.

**AT-08 - Async payload is small**

Submit a realistic dataset bundle and confirm `/run` request contains only identifiers/digests/policy and remains far below 10 MB.

**AT-09 - Single dispatch**

Double-click start and run two scheduler ticks concurrently; one RemoteExecution and one provider training claim result.

**AT-10 - Ambiguous POST**

Simulate network loss after RunPod accepts POST. Job becomes `submission_unknown`, no automatic duplicate is sent, and reconciliation/worker claim recovers the accepted execution.

**AT-11 - H100 unavailable**

Job remains visibly queued or fails with capacity policy; it never runs on A100/H200/other fallback without a new explicit user decision.

**AT-12 - Endpoint auto-disabled**

With RunPod inactivity scale-down setting max workers to zero, Test connection and submission report how to re-enable; no stuck local “Starting job...” state.

### C. Live progress and UI restart

**AT-13 - Cold start phases**

First run displays RunPod queue, worker start, model download/cache, dataset load, and training as distinct phases with heartbeats.

**AT-14 - Live loss/log/sample**

During a short real run, the existing job page shows new log text, step/speed, loss points, and a generated sample before completion.

**AT-15 - Browser restart**

Close/reopen the browser; progress continues because the server-side cron worker owns orchestration.

**AT-16 - Controller restart**

Stop/restart the Node worker during training. It reclaims reconciliation, resumes from event/log/metric cursors, and neither starts another job nor duplicates data.

**AT-17 - Temporary internet outage**

Disconnect controller network for several polling intervals. UI shows stale communication, remote worker continues, and state catches up on reconnection.

**AT-18 - Loss DB safety**

Continuously write remote metrics while importing them; local `loss_log.db` passes integrity check and graph contains each `(step,key)` once.

### D. Stop, failure, timeout, and resume

**AT-19 - Cancel queued job**

Cancel before a worker starts; provider reports cancelled, no trainer/output prefix beyond control/result metadata, and no model GPU time is used.

**AT-20 - Safe stop during training**

Request stop between saves. Trainer acknowledges via private DB hook, finalizes the last valid checkpoint, and UI ends `stopped` with resume candidate.

**AT-21 - Safe stop during save**

Request stop while status is `Saving model`. Worker keeps heartbeat, waits for save to finish, then stops. The saved checkpoint verifies.

**AT-22 - Force cancel**

Simulate unresponsive trainer, let grace expire, force cancel, and verify UI warns appropriately and never advertises the in-progress file as valid.

**AT-23 - OOM/config/data failure**

Each deterministic failure maps to its code, preserves diagnostics/prior artifacts, releases queue, and does not auto-retry paid work.

**AT-24 - Execution timeout/TTL**

Use short test policies. Timeout maps correctly; durable partial state remains. TTL expiry/404 does not cause blind resubmit.

**AT-25 - Infrastructure retry from checkpoint**

Simulate worker loss after a verified checkpoint. A user-approved new attempt references its hash and resumes; no automatic replay occurs without the checkpoint.

**AT-26 - Add 500 steps**

From a verified step-2000 run, choose Continue +500. Review shows final total 2500, same dataset/config/model identities except recorded total-steps diff, and training starts at 2000.

### E. Completion, artifacts, retention, and ComfyUI

**AT-27 - Atomic completion**

Provider says completed before artifact finalization. UI remains syncing until result/index/required hashes and `COMPLETE` verify.

**AT-28 - Corrupt download**

Return a truncated LoRA once. Reconciler detects hash mismatch, keeps `.part`, retries, and never replaces an existing good file.

**AT-29 - Provider result expiry**

After the 30-minute RunPod result window, delete/expire API result and rebuild local state from the volume's result/marker/artifact index.

**AT-30 - Local disk full**

Fill the local sync target. Remote run remains completed and recoverable; UI shows artifact-sync failure and retries after space is freed.

**AT-31 - ComfyUI use**

Downloaded `.safetensors` and provenance are placed/revealed in the configured local output. Copy/link the LoRA into the configured ComfyUI LoRA directory and generate using Krea 2 Raw plus the literal trigger; file hash matches artifact index.

**AT-32 - Network-volume cleanup boundary**

Deleting the local AI Toolkit Job does not delete remote bundle/run/archive. A separate purge action lists exact prefixes, retention impact, and requires confirmation.

### F. Security and isolation

**AT-33 - Secret non-disclosure**

Seed fake canaries into all configured credentials and force errors. Browser responses, SQLite Job/RemoteExecution, bundle, manifest, logs, progress, results, artifact indexes, and exception telemetry contain none.

**AT-34 - Malicious bundle**

Upload a traversal/symlink/bomb archive directly to storage and submit its identifiers. Worker rejects before extraction/model load and writes a security-classified terminal result.

**AT-35 - Forged object key/URL**

Send absolute key, `../`, alternate bucket, `file://`, metadata IP URL, and overlong identifiers. Schema/path checks reject all without outbound fetch.

**AT-36 - Queue isolation**

Run local 5090 training, Gemini cloud captioning, and RunPod training together. Each uses its own queue/resource and progress remains attached to the correct Job.

**AT-37 - Endpoint returns to zero**

After completion/stop/failure, confirm the endpoint has zero active workers after configured idle timeout and no Pod resource was orphaned.

### G. Optional AWS archive

**AT-38 - Archive success**

With the local `echoflicks` profile, archive bundle/result/final artifacts and verify SHA-256 without sending AWS credentials to RunPod.

**AT-39 - Archive outage**

AWS upload fails after RunPod success. UI keeps training completed, marks archive sync failed, and retry succeeds idempotently.

**AT-40 - Archive retention/versioning**

Uploading the same digest is idempotent; conflicting bytes cannot overwrite; configured retention does not delete the only resume artifact prematurely.

## 13. Performance, cost, and scalability test gates

- Export hashes files streaming with bounded memory; target under 250 MB RSS for a multi-gigabyte dataset.
- Reconciler performs O(new chunks/artifacts) work, not O(all remote files) each second.
- Log API remains bounded by its existing tail behavior; remote log chunk import must not inflate duplicate progress-bar lines uncontrollably.
- Metric importer batches transactions and does not block the one-second cron loop for long runs.
- Bundle upload reports throughput/ETA and can recover from a one-minute connection interruption.
- First real run records model-cache miss time; second records cache hit. If cache hit still downloads the base model, rollout blocks.
- Endpoint max workers remains one in MVP. A UI setting cannot raise it.
- Execution timeout defaults to a conservative value above measured 2000-step duration and below the platform maximum. TTL includes queue headroom and must exceed execution timeout.
- Surface an estimated maximum execution charge from configured timeout and a timestamped rate, but label it an estimate and link to [RunPod pricing](https://www.runpod.io/pricing).
- Network-volume bytes and optional AWS archive bytes are reported because zero active GPU does not mean zero storage cost.

## 14. Observability and support runbook requirements

### Structured controller log fields

- local Job ID;
- RemoteExecution ID and attempt;
- RunPod job ID after known;
- request key prefix (not full secrets or signed URLs);
- state transition and source (`provider`, `durable`, `controller`);
- bundle content digest prefix and worker image digest prefix;
- retry category/count/delay;
- artifact chunk/index sequence and bytes;
- elapsed queue, run, and sync times.

### User-visible diagnostics

- Last successful provider poll and durable-state poll.
- Heartbeat age and phase-aware expectation.
- Last imported event/log/metric/artifact sequence.
- Exact normalized error code with recommended action.
- Whether remote compute may still be billable.
- Whether required artifacts are safely present remotely and/or locally.

### Required runbooks

1. Rotate RunPod API and storage keys.
2. Configure endpoint, image digest, H100-only policy, network volume, and secrets.
3. Recover endpoint max-workers after automatic inactivity scale-down.
4. Investigate `submission_unknown` without duplicating work.
5. Diagnose stale heartbeat by phase.
6. Safely stop versus force cancel.
7. Recover artifacts after API-result expiry.
8. Resume from a verified checkpoint.
9. Verify endpoint scaled to zero and no Pod exists.
10. Clean bundle/run/model-cache/archive storage with exact-prefix dry run.
11. Restore a local SQLite backup after schema upgrade failure.
12. Use a downloaded Krea 2 LoRA and trigger in ComfyUI.

## 15. Delivery sequence and pull-request boundaries

Avoid one oversized PR. Suggested sequence:

1. **PR A - Contracts and persistence:** RPT-000 to RPT-002.
2. **PR B - Caption provenance and validation:** RPT-003 to RPT-004.
3. **PR C - Bundle exporter/importer and portable config:** RPT-005 to RPT-007.
4. **PR D - ArtifactStore and RunPod client:** RPT-008 and RPT-013.
5. **PR E - Worker image, safe import, and private DB:** RPT-009 to RPT-010.
6. **PR F - Worker execution/progress/artifact finalization:** RPT-011 to RPT-012.
7. **PR G - Dispatch and reconciliation:** RPT-014 to RPT-015.
8. **PR H - Stop and resume:** RPT-016 to RPT-017.
9. **PR I - UI and local compatibility:** RPT-018 to RPT-020.
10. **PR J - Test harness, docs, and rollout:** RPT-022 to RPT-023.
11. **PR K - Optional AWS archive:** RPT-021, independently after ArtifactStore stabilizes.

Every PR should be independently testable, preserve local behavior, and keep remote UI hidden until its backend path is safe. RPT-024 is a later design/implementation series.

### Critical path

`RPT-000 -> RPT-001 -> RPT-002 -> RPT-003/004 -> RPT-005/006 -> RPT-007/008/009 -> RPT-010 -> RPT-011 -> RPT-012 -> RPT-013/014 -> RPT-015 -> RPT-016/017 -> RPT-018/019/020 -> RPT-022 -> RPT-023`

Expected MVP effort: approximately **32-40 engineering days**, excluding external account setup and waiting for real GPU capacity. A narrower first demo can omit resume, AWS archive, and advanced UI, but must not omit security, bundle validation, idempotency, durable results, or safe stop.

## 16. Rollout gates

### Gate 1 - No-cost local contracts

- All Python and TypeScript unit/contract tests pass.
- Deterministic bundle and malicious archive suites pass on Windows and Linux.
- Fake provider/storage end-to-end suite passes every restart/failure case.
- Secret scan passes.

### Gate 2 - RunPod connection without GPU

- API/storage credentials rotated and configured through environment.
- Test connection verifies zero-active/one-max/H100-only/volume/image policy.
- Bundle upload/read-back works without starting a worker.

### Gate 3 - Tiny worker smoke

- No-op/fake trainer starts on endpoint, reports progress, writes result, syncs, and scales to zero.
- Ambiguous submission and cancellation behavior are manually verified.

### Gate 4 - Bounded Krea 2 smoke

- Small-step Krea 2 Raw run on H100 completes and downloads verified LoRA/sample/loss.
- Controller restart and safe stop/resume pass.
- Cache miss/hit behavior and total billed time are recorded.

### Gate 5 - Analog-horror production opt-in

- Full preflight has no blocking errors and accepted warnings are recorded.
- User reviews immutable identities and maximum-runtime cost estimate.
- Feature remains opt-in until at least five successful representative runs with no orphaned compute or corrupt artifacts.

## 17. Definition of done

The feature is done only when all of the following are true:

- A local Job can select RunPod H100 while Local GPU remains default.
- Export creates and verifies the requested bundle layout and all validation rules.
- Gemini model/prompt provenance and trigger coverage are recorded.
- Code, image, dependency, base-model, dataset, config, and seed identities are immutable and visible.
- Submission is idempotent across double clicks, scheduler races, HTTP ambiguity, and app restarts.
- A zero-active/one-max H100 endpoint is enforced before every paid run.
- Remote progress, logs, loss, samples, and checkpoints appear through the existing job UI.
- Normal stop is checkpoint-safe; force cancel is explicit; verified resume works as a new attempt.
- Provider API-result expiry does not lose results.
- Artifact transfer is checksum-verified and crash-safe.
- No secret appears in browser state, SQLite job data, bundles, logs, progress, results, or artifacts.
- Local training and Gemini captioning regression suites remain green.
- A real H100 Krea 2 smoke run completes, downloads a usable LoRA, and the endpoint demonstrably scales to zero.
- Setup, failure recovery, retention/cleanup, cost limitations, and ComfyUI use are documented.

## 18. Explicit decisions still needed before implementation

These are configuration choices, not architecture blockers:

1. Container registry/repository used for the private worker image.
2. RunPod network-volume data center with acceptable H100 availability.
3. Bundle and run retention periods on the network volume.
4. Default execution timeout/TTL after measuring the current 2000-step 5090 and first H100 smoke runs.
5. Whether full caption prompt text is always retained or can be redacted while keeping its hash; strict reproducibility recommends retaining it.
6. Whether automatic local download includes every optimizer checkpoint or only final/selected resume candidates.
7. Optional AWS bucket, region, KMS key, and lifecycle policy.

Changing any of these later must not change bundle semantics or the worker/controller contracts.

## 19. Final recommendation

Build the deterministic bundle and artifact contracts first, then the worker, then UI orchestration. This order is important: it proves that the same experiment can be moved and verified before introducing paid remote lifecycle complexity. RunPod Serverless is the best initial match for the stated goal because it supplies a queue and can keep zero active workers, while the network volume makes the 30-minute API-result window irrelevant. AWS S3 is beneficial as an optional independent archive, but it is not required to start and should not be placed in the live training path.

The key technical simplification is to leave the AI Toolkit UI local and mirror remote results into its existing output layout. The key safety properties are immutable identities, no blind POST retry, one-writer run prefixes, checkpoint-aware stop, and atomic verified artifacts. Those properties should not be traded away for a faster first demo.
