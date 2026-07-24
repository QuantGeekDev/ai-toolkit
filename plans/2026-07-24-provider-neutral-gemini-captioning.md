# Provider-neutral cloud captioning for AI Toolkit

**Date:** 2026-07-24

**Initial provider/model:** Google Gemini API / `gemini-3.1-pro-preview`

**Reasoning mode:** `high` (explicitly configured)

**Status:** Implementation plan

**Target:** AI Toolkit built-in captioning workflow and Web UI

## 1. Executive decision

Add remote captioning as a first-class caption provider, beginning with Gemini 3.1 Pro Preview but keeping all Google-specific code behind a provider interface. Users will select **Gemini 3.1 Pro (Preview)** in the existing caption job UI, configure the credential once in Settings (or use `GEMINI_API_KEY`), and queue a caption job without writing code.

The first release will:

- send one image per stateless request;
- explicitly request `thinking_level: high` and high media resolution;
- request a minimal structured response containing only the caption;
- run in a dedicated `cloud` queue so it does not reserve a GPU or block training;
- keep credentials server-side and out of job JSON, API responses, browser state, and logs;
- use bounded concurrency and the SDK's bounded retry support for transient failures;
- preserve existing captions until a replacement has been generated and written atomically;
- continue past image-specific failures and produce a sanitized failure summary;
- expose provider/model fields in configuration so a later OpenAI, Anthropic, or compatible provider can use the same workflow.

This is deliberately not a general LLM gateway. It establishes the smallest stable provider boundary needed by AI Toolkit captioning, then implements one provider well.

## 2. Goals, non-goals, and success measures

### Goals

1. Caption an AI Toolkit image dataset through Gemini entirely from the Web UI.
2. Produce the same sidecar `.txt` files consumed by the existing training workflow.
3. Make a second provider an adapter addition rather than another captioning subsystem.
4. Make partial failure, cancellation, reruns, and recaptioning safe and understandable.
5. Prevent accidental credential disclosure and accidental GPU queue occupation.
6. Retain CLI/config-file use: advanced users can run the caption process with an environment variable and no UI.

### Non-goals for the first PR

- Automatic fallback to another paid provider. It can create unexpected cost and privacy transfers; any future cross-provider fallback must be explicit opt-in.
- Gemini Batch API. Direct requests give simpler cancellation, per-image progress, and error attribution. Batch is a later optimization after direct-call reliability is measured.
- Stateful conversations, background interactions, tools, web search, or model-generated images.
- Storing API keys in an OS keychain. The first implementation will support environment variables (preferred) and AI Toolkit's local SQLite settings store (documented as plaintext-at-rest). Keychain integration should be a separate cross-platform security project.
- Replacing existing local captioners or changing existing job configurations.
- Provider-specific prompt presets for every base model. The existing prompt remains editable and can be refined separately for Krea 2 dataset style.

### Success measures

- A clean install can configure a Gemini key, caption a folder, and immediately train from the generated `.txt` files.
- Cloud captioning can run while a GPU training queue is active.
- In a forced mixed-result test, successful captions remain usable, failed files are listed with actionable categories, and no pre-existing caption is lost.
- Network responses, persisted job JSON, process environment dumps, browser state, and normal/error logs contain no secret value.
- A fake provider can exercise the full job pipeline without network access; the real-provider smoke test is opt-in.

## 3. Current-system findings that shape the design

- `extensions_built_in/captioner/BaseCaptioner.py` owns file discovery, skip/recaption behavior, progress, cancellation polling, and `.txt` output. Local captioners subclass it and implement model loading plus `get_caption_for_file`.
- `CaptionConfig` currently requires `model_name_or_path` and constructs a Torch device even though a cloud captioner does not need either. The provider work should avoid pretending that a hosted model is a local model path.
- `ui/src/helpers/captionOptions.ts`, `captionJobConfig.ts`, `CaptionSimpleJob.tsx`, and `CaptionDatasetModal.tsx` define captioner selection, visible controls, job serialization, and queue start behavior.
- Jobs are queued by the string field `gpu_ids`. Reusing a real GPU ID for a cloud request would unnecessarily serialize it with training. A reserved `cloud` queue key provides isolation without a database migration.
- `ui/src/app/api/jobs/route.ts` currently changes every submitted queue to `mps` on macOS. Cloud jobs must be exempt.
- `ui/cron/actions/startJob.ts` exports `CUDA_VISIBLE_DEVICES` and injects `HF_TOKEN`. It is the correct server-side boundary for resolving provider credentials, but cloud jobs must omit the CUDA variable.
- `ui/src/app/api/settings/route.ts` returns all stored values, and `ui/src/hooks/useSettings.tsx` logs them. Adding a provider key without changing this would expose it to the browser. Secret handling is therefore a prerequisite, not polish.
- Settings already use a generic key/value Prisma table, so no database migration is required for a Gemini credential.
- Python has an established `unittest` suite. The UI has build/lint scripts but no focused unit-test runner; adding a minimal Vitest setup is part of this feature rather than leaving UI serialization untested.
- The repository pull-request template says automated AI-agent PR submissions are not accepted. The implementation may be prepared locally, but the contributor must personally review, test, author, and submit the PR.

## 4. External research and adopted patterns

### Gemini decisions

- Google's [Gemini 3 developer guide](https://ai.google.dev/gemini-api/docs/gemini-3) lists `low`, `medium`, and `high` for Gemini 3.1 Pro and says high is the default. We will still send `high` explicitly so a provider default change cannot silently alter caption quality. We will not send legacy `thinking_budget` alongside it.
- The [`gemini-3.1-pro-preview` model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview) confirms image input, text output, structured outputs, and thinking support. Because this is a preview model, the model ID remains configurable and errors must distinguish model retirement from invalid credentials.
- Google recommends the [Interactions API](https://ai.google.dev/gemini-api/docs/interactions-overview) for new work as of June 2026. It stores interactions by default, so caption requests must set `store=false`. Google's [`python-genai` repository](https://github.com/googleapis/python-genai), however, still labels its Interactions surface preview and records Interactions-only breaking changes. Ticket CAP-001 therefore verifies the installed SDK/API combination before choosing the internal Gemini transport. If a required field is unavailable or unstable, use `generateContent` behind the same `GeminiCaptionProvider`; no UI or job-schema change is allowed.
- Use per-image high resolution following the [media-resolution guide](https://ai.google.dev/gemini-api/docs/media-resolution), with a configurable enum and `high` default. Do not default to ultra-high: captioning does not justify the extra tokens/cost without an evaluation showing a material gain.
- Use a deliberately small schema following the [structured-output guide](https://ai.google.dev/gemini-api/docs/structured-output): `{ "caption": string }`. Validate the value after parsing because schema-valid output can still be semantically wrong.
- Follow the [official troubleshooting guidance](https://ai.google.dev/gemini-api/docs/troubleshooting): retry only transient timeout/network/408/429/5xx failures with exponential backoff and jitter; do not retry malformed requests or permission failures. The current SDK already retries transient failures, so configure one retry layer and do not multiply SDK retries by application retries.
- Follow Google's [API key guidance](https://ai.google.dev/gemini-api/docs/api-key): prefer environment variables, never expose a key client-side, and document restricted/auth keys. As of this plan date, Google says standard keys will be rejected starting September 2026; the documentation must direct users toward authorization keys rather than baking in a soon-to-expire setup.
- Treat blocked prompts/responses as per-file outcomes using the documented `blockReason`, `finishReason`, and ratings from the [safety settings guide](https://ai.google.dev/gemini-api/docs/safety-settings). Do not automatically weaken safety settings or retry blocked content with evasive prompts.

### Open-source patterns worth borrowing

- [`qinglong-captions`](https://github.com/sdbds/qinglong-captions) uses a modular Provider V2 base, provider registration, a unified `CaptionResult`, capability-aware behavior, retry handling, and progress reporting across local and cloud providers. AI Toolkit should borrow the narrow provider/result/capability concepts, but not its priority-based automatic routing: provider selection here stays explicit.
- [`IMG-Dataset-Refiner`](https://github.com/NyxAwroo/IMG-Dataset-Refiner) demonstrates that one dataset GUI can offer Gemini, Claude, OpenAI, and local captioning. That supports provider-neutral UI metadata rather than provider-specific pages.
- [`Gemini-API-Image-Captioner-with-UI`](https://github.com/tobiasgpeterson/Gemini-API-Image-Captioner-with-UI) and [`lora-captioner`](https://github.com/RalFingerLP/lora-captioner) demonstrate the practical LoRA workflow of writing one text sidecar per image. AI Toolkit should preserve that convention instead of inventing a separate caption database.

### Known SDK failure reports to cover with tests

These are evidence for defensive boundaries, not reasons to depend on issue-specific workarounds:

- [Thinking plus structured output can consume the output budget](https://github.com/googleapis/python-genai/issues/782). Do not use a tiny `max_output_tokens`; enforce caption length through prompt, schema, and validation. A `MAX_TOKENS` result gets at most one retry with a larger bounded cap.
- Historical [structured-output schema](https://github.com/googleapis/python-genai/issues/1238), [Unicode/schema](https://github.com/googleapis/python-genai/issues/1378), and [parsed-output](https://github.com/googleapis/python-genai/issues/1665) reports justify strict parsing, Unicode normalization, and a sanitized raw-response diagnostic path.
- [503/capacity reports](https://github.com/googleapis/python-genai/issues/1373) justify bounded backoff and a clear exhausted-retry outcome.
- [Streaming error parsing](https://github.com/googleapis/python-genai/issues/1162) supports using non-streaming single-image calls in the first version.

## 5. Proposed architecture

### Execution flow

```text
Caption UI
  -> provider-aware job config (never contains a key)
  -> jobs API assigns queue key: cloud
  -> queue worker resolves GEMINI_API_KEY server-side
  -> CloudCaptioner process
       -> provider factory
       -> GeminiCaptionProvider
       -> image preparation in memory
       -> Gemini API (stateless, non-streaming)
       -> validated CaptionResult
       -> atomic .txt replacement
  -> progress + sanitized per-file error summary
```

### Provider-neutral Python boundary

Add a small `extensions_built_in/captioner/providers/` package:

```python
class CaptionProvider(Protocol):
    capabilities: ProviderCapabilities

    def validate_configuration(self) -> None: ...
    def caption(self, request: CaptionRequest) -> CaptionResult: ...
    def close(self) -> None: ...

@dataclass(frozen=True)
class CaptionRequest:
    image_bytes: bytes
    mime_type: str
    prompt: str
    source_name: str       # basename for diagnostics only

@dataclass(frozen=True)
class CaptionResult:
    caption: str
    provider: str
    model: str
    request_id: str | None
    usage: UsageMetrics | None
    attempts: int
```

Provider exceptions must be normalized to a stable taxonomy:

- `ProviderConfigurationError`
- `ProviderAuthenticationError`
- `ProviderModelError`
- `ProviderRateLimitError`
- `ProviderTransientError`
- `ProviderSafetyError`
- `ProviderResponseError`
- `ProviderCancelledError`

`CloudCaptioner` handles dataset iteration, progress, cancellation, concurrency, and safe file writes. `GeminiCaptionProvider` handles only Gemini client construction, request translation, response translation, and Gemini-specific error classification. A later provider therefore implements one adapter and declares capabilities; it does not touch queueing or caption-file logic.

Avoid automatic discovery magic in the first PR. Use an explicit factory registry such as `{"gemini": GeminiCaptionProvider}` so supported code paths are reviewable, unknown providers fail clearly, and a misspelled config cannot import arbitrary modules.

### Job configuration

Proposed caption block (names are provider-neutral except under `provider_options`):

```yaml
type: CloudCaptioner
caption:
  provider: gemini
  model: gemini-3.1-pro-preview
  path_to_caption: C:/datasets/example
  caption_prompt: "Describe this image for image-model training..."
  caption_extension: txt
  recaption: false
  concurrency: 2
  request_timeout_seconds: 120
  max_attempts: 4
  max_output_tokens: 2048
  provider_options:
    thinking_level: high
    media_resolution: high
    store: false
```

Validation rules:

- `provider`, `model`, `path_to_caption`, and a nonblank prompt are required.
- `concurrency` defaults to 2, minimum 1, maximum 8. Conservative defaults reduce preview-model quota pressure.
- `max_attempts` includes the initial call and is bounded 1–6.
- timeout and output budget have safe bounds; `MAX_TOKENS` may double once only up to the configured ceiling.
- Gemini 3.1 accepts `low|medium|high`; the UI defaults to and explicitly serializes `high`.
- `thinking_budget` is not part of the neutral schema and is rejected in Gemini options if manually supplied with `thinking_level`.
- `store` is forced to `false` in this captioning adapter. A job file cannot opt into provider-side interaction storage accidentally.
- No credential field is accepted in job configuration. Environment/server settings are the only sources.

### Credential resolution and persistence

Resolution order:

1. `GEMINI_API_KEY` in the server/worker environment.
2. The provider secret saved in local settings.
3. Fail before processing images with an actionable configuration error.

Implementation requirements:

- Split public settings from secret settings. `GET /api/settings` returns `geminiApiKeyConfigured: boolean` and `geminiApiKeySource: "environment" | "local" | null`, never the value.
- Use patch semantics for secrets: omitted means unchanged, a nonblank value means replace, and an explicit `clear: true` means delete. A blank UI input must never overwrite a stored key.
- Remove the full-settings `console.log`; audit all job/process logs for environment dumps or exception objects that might contain request headers.
- Inject the resolved key only into the caption subprocess. Do not write it into job config or database job metadata.
- Prefer `GEMINI_API_KEY` and document that local persistence is plaintext in AI Toolkit's ignored SQLite file. Do not describe it as encrypted or secure storage.
- Add a server-side **Test connection** action. It returns only success or a normalized error. Prefer a low/no-generation model metadata check; if the chosen API cannot validate access without generation, use the smallest possible call and label that it can consume quota.
- Apply the same non-disclosure pattern to the existing HF token while touching the settings route, preventing a parallel known leak path.

### Image preparation

Prepare a request copy in memory; never edit the dataset image:

- accept current AI Toolkit image extensions;
- apply EXIF orientation;
- reject corrupt images and decompression-bomb-sized inputs with a per-file validation error;
- preserve aspect ratio, never upscale, and downscale to a configurable pixel ceiling;
- preserve PNG when transparency matters; otherwise encode a quality-controlled JPEG;
- convert CMYK, palette, grayscale, and unsupported formats into a Gemini-supported RGB/RGBA payload;
- set MIME type from the encoded bytes, not the source extension;
- cap encoded payload size and progressively reduce dimensions/quality within documented bounds;
- never upload through the Files API for these single-image requests, avoiding remote-file lifecycle cleanup.

### Caption validation and writes

- Parse the minimal JSON object and require a nonblank string.
- Normalize line endings and Unicode to NFC; remove NUL/control characters while preserving ordinary multilingual text.
- Enforce a configurable character ceiling and reject suspicious provider boilerplate or fenced JSON instead of silently writing it.
- Write to a temporary file in the same directory, flush/close it, then use `os.replace` for atomic replacement.
- With `recaption: true`, do not delete or truncate the old caption before a successful API response and atomic replace.
- With `recaption: false`, preserve current skip behavior.
- If an existing caption appears after scheduling (another process race), re-check before replace and follow the job's recaption policy.

### Concurrency, cancellation, and progress

- Assign cloud caption jobs `gpu_ids = "cloud"`; show the queue as **Cloud API**, not as a GPU.
- On macOS, preserve `cloud` rather than rewriting it to `mps`.
- For cloud jobs, omit `CUDA_VISIBLE_DEVICES`; set caption device to CPU only where the inherited process requires a value.
- Use bounded direct-call concurrency. Stop scheduling new work immediately after cancellation; allow in-flight requests to finish only until their request timeout, then exit.
- Update progress exactly once per source image (success, skip, or terminal per-file failure), even when futures complete out of order.
- Use a single configured retry mechanism. If SDK retries are enabled, translate its final exception without wrapping it in another four-attempt loop. Inject the sleeper/random source in tests so retry tests are deterministic and instant.

### Error and retry policy

| Condition | Retry | Scope | User-visible behavior |
|---|---:|---|---|
| Missing key/invalid config | No | Job | Fail before first image; point to Settings/env variable |
| 400 malformed/unsupported option | No | Job | Sanitized invalid-request message; suggest model/API compatibility |
| 401/403 invalid or unauthorized key | No | Job | Authentication error; never include key or headers |
| 404/unsupported/retired model | No | Job | Model-specific error; preserve model ID in message |
| 408/429/network/500/502/503/504 | Yes, bounded | Image | Exponential backoff with full jitter; respect retry metadata/header |
| Safety/policy block | No | Image | Mark blocked and continue; do not weaken filters automatically |
| `MAX_TOKENS` | Once | Image | Retry with larger bounded output cap; then response error |
| Invalid/empty/schema response | Once at most | Image | Repeat with same simple schema; then response error |
| Corrupt/oversize image | No | Image | Skip with local validation category |
| Disk permission/full error | No | Job after current failure | Preserve old caption and stop to avoid a folder full of partial results |
| Cancellation | No | Job | Stop scheduling, record cancelled state, preserve completed files |

Do not include raw response bodies in ordinary logs. An opt-in debug log may store a truncated, sanitized text response plus request ID, but never image bytes, request headers, full prompts containing user secrets, or API keys.

### Result reporting

Keep the existing database job status and add aggregate counters to the final status message: processed, captioned, skipped, failed, retried, blocked, and cancelled. Write a JSONL failure report under the job/output area (not the dataset folder) with:

- relative or sanitized source path;
- stable error category;
- attempt count;
- provider/model;
- request ID when provided;
- sanitized message and timestamp.

Capture usage fields when the API supplies them, including thinking/output tokens, but do not hard-code cost estimates because pricing and preview behavior can change. Absence of usage metadata must not fail a caption.

## 6. Detailed implementation tickets

### CAP-001 — Gemini SDK/API compatibility spike and contract fixture

**Dependencies:** none | **Estimate:** 0.5 day

Tasks:

- In an isolated script/test, pin the latest compatible `google-genai` version and verify Python support for multimodal Interactions requests, `store=false`, `thinking_level=high`, per-image `media_resolution=high`, non-streaming output, structured response format, timeouts, retry configuration, request IDs, usage metadata, and cancellation/close behavior.
- Record the exact request and response shapes as sanitized test fixtures.
- Verify whether model/access validation can be done without a billable generation.
- Choose Interactions when all required fields are stable. Otherwise record the gap and use `generateContent` inside the Gemini adapter, preserving identical neutral inputs/results.
- Confirm supported Python versions against both AI Toolkit and the selected SDK; do not raise the repository's Python floor incidentally.

Acceptance:

- A short decision record in this plan's implementation PR states SDK version, transport, required API version, and fallback rationale.
- A one-image request succeeds with the exact chosen model and all four explicit settings: high thinking, high media resolution, structured output, and no interaction storage.
- No experimental transport detail leaks into UI types or general provider contracts.

### CAP-002 — Provider contracts, factory, and neutral config

**Dependencies:** CAP-001 | **Estimate:** 0.5 day

Files: new `extensions_built_in/captioner/providers/` package, `BaseCaptioner.py`, new `CloudCaptioner.py`, captioner export/registration.

Tasks:

- Add typed request/result/capabilities, normalized exceptions, and an explicit provider registry.
- Add `CloudCaptionConfig` that does not require a local model path or GPU-specific fields.
- Validate bounds and reject keys/unknown options with field-specific messages.
- Keep local captioner behavior/config backward compatible.
- Lazily import provider SDK code so non-cloud workflows fail only with an actionable missing-dependency error, not during general extension discovery.

Acceptance:

- A fake provider can be registered and run through `CloudCaptioner` without Torch model loading.
- Unknown provider and malformed option errors occur before file processing.
- All existing local captioner tests and a representative legacy config still pass.

### CAP-003 — Gemini provider adapter

**Dependencies:** CAP-001, CAP-002 | **Estimate:** 1 day

Tasks:

- Add the pinned `google-genai` dependency in the appropriate requirements file and document why it is required.
- Construct the client from a passed-in credential; do not read settings inside the adapter.
- Translate neutral request fields to the chosen Gemini transport.
- Explicitly set model, high thinking, high media resolution, `store=false`, non-streaming mode, a simple JSON schema, timeout, and the one selected retry configuration.
- Parse caption, finish/block reason, request ID, and optional usage; normalize exceptions without retaining headers/client objects in exception text.
- Close network resources deterministically.

Acceptance:

- A request-spy test proves the exact model/options are wired.
- Adapter tests cover success, Unicode, empty response, schema error, max tokens, safety block, auth failure, invalid model, rate limit, timeout, and 503.
- `repr`/`str` for configuration, provider, and exceptions never includes the test key.

### CAP-004 — Safe image preparation

**Dependencies:** CAP-002 | **Estimate:** 0.5 day

Tasks:

- Add an in-memory image preparation utility with EXIF transpose, mode conversion, aspect-preserving resize, payload limit, supported MIME encoding, and decompression-bomb protection.
- Make size/resolution ceilings configurable internally with safe defaults established by CAP-001.
- Return a normalized provider request without changing source files.

Acceptance:

- Fixture tests cover JPEG with EXIF rotation, PNG alpha, grayscale, palette, CMYK, WebP, BMP conversion, corrupt input, extreme dimensions, and a payload that requires iterative reduction.
- Source hashes and modification times remain unchanged.

### CAP-005 — Cloud caption loop, atomic writes, retry outcomes, and cancellation

**Dependencies:** CAP-002, CAP-003, CAP-004 | **Estimate:** 1 day

Tasks:

- Reuse or extract current file discovery, extension filtering, skip, and recaption semantics.
- Add bounded concurrency with deterministic progress accounting and cancellation-aware scheduling.
- Implement semantic caption validation and same-directory atomic replace.
- Classify failures using the policy table; abort on job-scoped faults and continue on file-scoped faults.
- Produce aggregate status and sanitized JSONL failure records outside the dataset.
- Ensure provider/client cleanup in success, exception, and cancellation paths.

Acceptance:

- A mixed fake-provider job produces all successful sidecars, one error record per failed image, correct progress/counters, and the existing `completed` state with an explicit "completed with errors" info message. Do not add a new database status solely for this feature.
- Failed recaption leaves the old caption byte-for-byte intact.
- Cancellation stops new requests and exits within request timeout plus a small cleanup allowance.
- Measured concurrent calls never exceed the configured limit.

### CAP-006 — Secret-safe settings and credential resolution

**Dependencies:** none; blocks live-provider UI acceptance | **Estimate:** 1 day

Files: `ui/src/app/api/settings/route.ts`, `ui/src/hooks/useSettings.tsx`, `ui/src/app/settings/page.tsx`, server settings helpers, and route tests.

Tasks:

- Separate public settings DTOs from stored secret records.
- Add masked configured/source state, explicit set/clear operations, input validation, and server-only resolution with environment priority.
- Remove full settings logging and audit adjacent error logs.
- Apply the same response masking to `HF_TOKEN` while preserving current functionality.
- Add a provider connection-test route with normalized, non-secret output and basic request throttling to prevent double-click cost/rate bursts.
- Show the environment-source credential as configured but not editable/clearable from the UI.

Acceptance:

- No GET response contains either stored secret.
- Saving unrelated settings does not modify either secret.
- Blank input is unchanged; explicit clear deletes only the local value; an environment value remains effective.
- Server logs and test failure responses do not contain a canary secret.

### CAP-007 — Cloud queue and worker environment isolation

**Dependencies:** CAP-002, CAP-006 | **Estimate:** 0.5 day

Files: jobs API, `CaptionDatasetModal.tsx`, queue helpers/components, `ui/cron/actions/startJob.ts` and queue processor tests.

Tasks:

- Assign provider metadata an `executionTarget: "cloud" | "local_gpu"` and map cloud jobs to the reserved `cloud` queue key.
- Exempt the cloud key from macOS `mps` rewriting.
- Display **Cloud API** consistently in queue controls/status.
- Resolve and inject only the selected provider's key into the caption subprocess.
- Omit `CUDA_VISIBLE_DEVICES` for cloud jobs; do not disturb existing GPU/MPS behavior.
- Ensure cloud and GPU queue processors can run concurrently and cloud queue restart controls are reachable.

Acceptance:

- Serialized Gemini jobs use `gpu_ids: "cloud"` and contain no key.
- On Windows, Linux, and simulated macOS, the worker environment contains the expected provider key and no forced CUDA device.
- A running GPU training job does not prevent a cloud caption job from starting.

### CAP-008 — Provider-aware caption UI

**Dependencies:** CAP-002, CAP-006, CAP-007 | **Estimate:** 1 day

Files: `captionOptions.ts`, `captionJobConfig.ts`, `CaptionSimpleJob.tsx`, `CaptionDatasetModal.tsx`, `types.ts`, settings page.

Tasks:

- Extend caption option metadata with cloud group, execution target, provider ID, and capability-driven fields.
- Add Gemini 3.1 Pro Preview with defaults for high thinking, high media resolution, model ID, concurrency, timeout, and output budget.
- Hide local-only GPU, quantization, low-VRAM, compile, dtype, and local model controls for cloud providers.
- Show provider model, prompt, reasoning level, media resolution, concurrency, privacy/cost disclosure, and credential status.
- Disable queue submission if no effective credential or path is present; link directly to Settings.
- Preserve advanced/custom model entry so preview retirement does not require an immediate UI release.
- Add a confirmation/disclosure that images leave the machine and are processed under provider terms.

Acceptance:

- Selecting Gemini creates a valid cloud config with all intended defaults.
- Switching local -> cloud -> local neither leaks irrelevant fields into the active config nor destroys valid per-provider draft values unexpectedly.
- GPU controls are absent for Gemini and remain unchanged for existing captioners.
- The browser never receives the key.

### CAP-009 — Unit and route-test infrastructure

**Dependencies:** can begin after CAP-002/CAP-006; completes after CAP-008 | **Estimate:** 1 day (can overlap feature tickets)

Tasks:

- Add Python unit tests under `testing/` using fake clients/providers and injected clock/sleep/random functions.
- Add a minimal Vitest setup for pure TypeScript helpers/components and server routes; avoid a large browser-testing framework solely for this feature.
- Add secret redaction assertions using canary values in captured logs, JSON, environment snapshots, and error responses.
- Add fixtures without copyrighted or sensitive photographs; generated geometric images are sufficient for transport tests.

Required Python unit cases:

- config defaults/bounds and rejection of incompatible thinking fields;
- provider registry and capability handling;
- exact Gemini request wiring;
- every error category and retry/no-retry decision;
- `Retry-After`/retry metadata, jitter bounds, exhaustion, and no double retry;
- response schema, multilingual Unicode/NFC, control-character cleanup, empty/oversized captions;
- image orientation/modes/resizing/payload limits;
- atomic write and old-caption preservation;
- skip/recaption/race behavior;
- concurrency maximum, cancellation, progress exactly once, and client close;
- credential redaction.

Required UI/server unit cases:

- Gemini option defaults and config serialization;
- local/cloud field visibility logic;
- cloud queue selection including macOS;
- public settings DTO never contains secrets;
- secret set/unchanged/clear and environment precedence;
- job submission contains no credential;
- connection-test normalization and throttling.

Acceptance:

- Tests run with documented commands on Windows and Linux CI.
- Default test runs require no API key and perform no external calls.
- An opt-in live test is skipped unless a dedicated environment flag and key are both present.

### CAP-010 — End-to-end acceptance, quality evaluation, and documentation

**Dependencies:** CAP-003 through CAP-009 | **Estimate:** 1 day

Tasks:

- Add setup/user documentation: authorization key creation/restriction, `GEMINI_API_KEY`, local persistence tradeoff, model preview status, billing/rate limits, privacy, and rerun behavior.
- Document provider-adapter authoring in a short developer section with a fake-provider example.
- Build a small, redistributable evaluation set covering people, products, illustration, typography, multiple subjects, unusual aspect ratios, transparent assets, and multilingual text.
- Compare high vs medium reasoning and high vs lower media resolution on caption correctness, text transcription, latency, and token use. Keep user-requested high/high as defaults unless results reveal a correctness regression; record data rather than silently changing them.
- Run the acceptance matrix below, all Python tests, UI tests, typecheck/lint/build, and one real-key smoke test.
- Review the repository PR policy. A human contributor must inspect the diff and generated captions, run the tests, write the final PR description, and submit it.

Acceptance:

- Documentation includes setup, security, cost/privacy, troubleshooting, and provider-extension guidance.
- All automated and manual acceptance cases pass or have an explicitly documented upstream provider limitation.
- The PR contains no real keys, generated customer captions, dataset images, SQLite files, or raw API responses.

## 7. Acceptance-test matrix

| ID | Scenario | Expected result |
|---|---|---|
| AT-01 | No environment or saved key | UI prevents submission; direct config fails before first image with setup guidance |
| AT-02 | Three-image fake-provider job | Three `.txt` files, completed status, correct counters, no GPU selected |
| AT-03 | One real Gemini image | Caption written; request spy/diagnostic confirms model, high thinking, high media, structured output, `store=false` |
| AT-04 | Existing caption, recaption off | File skipped and remains byte-identical |
| AT-05 | Existing caption, recaption on, API fails | Old file remains byte-identical; failure appears in report |
| AT-06 | 429 then success | Bounded delayed retry, one caption, retry counter increments |
| AT-07 | Persistent 503 | Attempts stop at configured limit; other images continue; actionable summary |
| AT-08 | Invalid/unauthorized key | No retry storm; job stops; response/log contains no key |
| AT-09 | Safety-blocked image | No filter weakening; file failure recorded; remaining images process |
| AT-10 | Corrupt and extreme-size files | Local validation failures; no API call for those files; no crash |
| AT-11 | Cancel during multi-image run | No new work scheduled; completed files valid; job becomes cancelled promptly |
| AT-12 | GPU training plus cloud captioning | Both run concurrently; cloud process has no CUDA reservation |
| AT-13 | macOS job submission | Cloud queue remains `cloud`, local job still maps to `mps` |
| AT-14 | Restart after saving local key | UI reports configured (masked); cloud worker resolves key and succeeds |
| AT-15 | Environment key plus saved key | Environment wins; UI shows environment source; saved value is never returned |
| AT-16 | Switch Gemini/local captioner repeatedly | Correct controls/config/queue restored with no cross-provider fields executed |
| AT-17 | Unicode caption with accents/CJK/emoji | Valid UTF-8 NFC sidecar with no mojibake or JSON fencing |
| AT-18 | Disk becomes unwritable | Existing files preserved; job stops rather than repeatedly calling a paid API |
| AT-19 | Browser network/log inspection | No API key in page source, state, response bodies, console, job payload, or logs |
| AT-20 | Clean dependency install | Local captioners still load; Gemini adapter loads; Python/UI builds and tests pass |

## 8. Rollout and compatibility strategy

1. Land provider contracts, security hardening, and fake-provider tests first in the branch.
2. Add the Gemini adapter and image/write reliability with no UI exposure until tests pass.
3. Wire cloud queue and UI behind the presence of the registered provider.
4. Run fake end-to-end tests on every supported platform; keep the real Gemini smoke test opt-in to avoid CI secrets and cost.
5. Manually evaluate a small dataset before presenting the option as ready.
6. If Interactions changes before merge, change only the Gemini transport layer and its fixtures. Do not churn job config or UI.
7. If `gemini-3.1-pro-preview` is retired, leave custom model entry available, update the default registry/documentation, and emit a clear model error rather than silently selecting a different quality/cost tier.

Backward compatibility requirements:

- Existing caption configs and local captioner labels behave identically.
- Existing queues and database rows require no migration.
- Existing `HF_TOKEN` continues to resolve even though it is no longer returned to the browser.
- The `cloud` queue key is reserved and documented; user-supplied GPU identifiers matching it are rejected/normalized.

## 9. Principal risks and planned mitigations

| Risk | Mitigation |
|---|---|
| Preview model/API breaks | Configurable model, CAP-001 transport gate, adapter-only transport code, actionable model errors |
| Secret exposed by current settings flow | CAP-006 blocks live integration; masked DTO, env priority, no console logging, redaction tests |
| Unexpected bill from retries/concurrency | Conservative concurrency, one retry layer, bounded attempts/time, no automatic provider fallback, usage counters |
| High thinking consumes output budget | Generous bounded output cap, simple schema, one MAX_TOKENS escalation, validation rather than tiny generation cap |
| Structured JSON is syntactically valid but poor | Minimal schema plus semantic validation; one bounded retry; failure instead of corrupt caption |
| Recaption destroys useful data | Same-directory atomic replace only after successful validation |
| Cloud captioning blocks training | Dedicated `cloud` queue and no CUDA environment |
| Cancellation still incurs calls | Stop scheduling immediately, low bounded concurrency, per-request timeout, deterministic cleanup |
| Provider safety block causes whole dataset failure | Per-file normalized safety outcome and continued processing; no automatic bypass |
| SQLite secret misunderstood as secure vault | Explicit plaintext-at-rest warning and environment-variable recommendation; keychain deferred |
| Provider-neutral layer becomes over-engineered | Only eight methods/data types needed by Gemini; explicit registry; no generic chat/tools/fallback gateway |

## 10. Definition of done

- [ ] Gemini 3.1 Pro Preview captions a dataset from the UI with explicit high reasoning.
- [ ] Requests use high media resolution, structured output, non-streaming mode, and stateless/no-store behavior.
- [ ] Job configs and browser/server responses never contain credentials.
- [ ] Environment and local saved-key flows work, with correct precedence and explicit clearing.
- [ ] Cloud jobs use the cloud queue, do not reserve CUDA/MPS, and can overlap GPU training.
- [ ] Existing captions are never lost on provider, validation, cancellation, or disk-write failure.
- [ ] Retries are bounded, classified, jittered, and not duplicated across SDK/application layers.
- [ ] Per-file failures and aggregate counters are actionable and sanitized.
- [ ] Python unit, UI/server unit, fake end-to-end, and opt-in real-provider smoke tests pass.
- [ ] Existing local captioners and settings continue to work.
- [ ] User and provider-author documentation is complete.
- [ ] A human contributor has reviewed, tested, authored, and submitted the PR in accordance with repository policy.

## 11. Estimated effort and critical path

Estimated engineering effort is **6–8 focused developer-days**, plus model-quality evaluation time:

- 0.5 day compatibility spike;
- 2.5–3 days provider/backend/reliability work;
- 1.5–2 days secret/queue/UI work;
- 1–1.5 days test infrastructure and coverage;
- 0.5–1 day acceptance, documentation, and human PR preparation.

Critical path: **CAP-001 -> CAP-002 -> CAP-003/004 -> CAP-005 -> CAP-007/008 -> CAP-010**. CAP-006 can begin immediately and must finish before any live credential is used through the UI; CAP-009 should progress alongside implementation rather than being deferred to the end.
