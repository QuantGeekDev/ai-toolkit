# RunPod remote training acceptance checklist

Run `powershell -ExecutionPolicy Bypass -File testing/run_remote_contract_tests.ps1` before any paid test. It validates deterministic bundles, archive traversal defenses, caption provenance, private control DB behavior, idempotent worker claims, secret redaction, safe RunPod retry policy, endpoint preflight logic, existing UI helpers, and the cron TypeScript build without allocating a GPU.

## Paid H100 smoke test

Use a disposable 10-20 step fixture before the analog-horror job.

- [ ] The exposed chat credential was revoked; a replacement exists only in the controller environment.
- [ ] Endpoint preflight reports `workersMin=0`, `workersMax=1`, one H100 type, no fallback, matching network volume, and matching worker digest.
- [ ] A bundle exported twice from the same clean commit has identical content/archive digests.
- [ ] The worker reports an actual GPU name containing `H100` and refuses a mismatched expected image digest.
- [ ] Cold run downloads the exact Hugging Face revision; second run uses the completed model-cache marker.
- [ ] UI step, info, speed, log, loss graph, and samples advance while the local 5090 remains unallocated.
- [ ] Restarting the local controller does not submit a second provider job; durable progress resumes reconciliation.
- [ ] Graceful stop creates `control/stop-ack.json`, exits at an AI Toolkit stop hook, and mirrors a verified checkpoint.
- [ ] Force cancel requires a separate warning and marks artifacts partial instead of complete.
- [ ] Continue +500 changes only the final step target/cadence-allowed fields, creates a child attempt, and resumes above the parent step.
- [ ] Altering dataset, model revision, trigger, seed, optimizer, precision, network rank, or quantization blocks resume before submission.
- [ ] Final LoRA/checkpoints match `artifacts.json` SHA-256 values before the local Job becomes completed.
- [ ] RunPod async result expiration does not affect recovery from the network volume.
- [ ] Endpoint returns to zero workers after completion; only documented network-volume storage remains billable.
- [ ] Optional AWS archive succeeds with a local standard credential chain and no AWS value appears in bundle, request, worker environment, or log.

Record endpoint ID, execution ID, source commit, bundle content digest, worker image digest, model revision, actual GPU, cache hit/miss, queue/cold-start time, step speed, stop behavior, final artifact hashes, and scale-to-zero evidence in the release note. Never record tokens, credential IDs, signed URLs, or profile files.
