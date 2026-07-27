# RunPod ComfyUI workspace threat model
Protected assets are Krea 2 LoRA checkpoints, generated images, provider
credentials, app authentication, controller master secret, SFTP key, and
billable Pod lifecycle. Trust boundaries include the authenticated local API,
SQLite/staging disk, RunPod control plane and public proxy, direct SFTP
mapping, Pod sidecar, and loopback-only ComfyUI.

| Threat | Control |
| --- | --- |
| Public ComfyUI access | Five-minute HMAC assertion in a URL fragment is exchanged for a random Secure/HttpOnly/SameSite=Strict cookie. Every HTTP and WebSocket route requires it. |
| Assertion replay/leakage | Fragment is removed from history, has workspace/expiry/nonce, and nonce is consumed once. It is never logged or stored. |
| Controller credential reaches Pod | Master/controller RunPod keys are prohibited. HKDF derives separate workspace controller/browser keys. RunPod injects its Pod-scoped key. |
| SSH shell/lateral access | Ed25519 only, HTTPS-attested host fingerprint, chrooted internal SFTP, no PTY/password/forwarding/tunnel/root shell. |
| Malicious path/checkpoint | Safetensors header validation, immutable snapshot and SHA-256, canonical relative POSIX manifest, bilateral traversal/symlink/special-file rejection, committed marker last. |
| Wrong or expensive Pod | Secure H100 allowlist, immutable image, price ceiling, one GPU, zero volume/network volume, required ports, and delete-before-upload on drift. |
| Duplicate billing | Create is never blindly retried. Exact name plus marker is reconciled; only marked duplicates are deleted. |
| Controller/browser disappears | Provider `terminateAfter` and remote idle self-delete. Idle begins at ready; invalid queue status suppresses idle deletion. |
| Stopped Pod breaks ephemerality | Controller only deletes and never restarts. Singleton lease releases only after confirmed absence. |
| Unbounded persistence | No remote S3/network volume. Container deletion is the erasure boundary; only verified images mirror locally. |
| Secret exfiltration | DTOs omit environment, SSH endpoint, local paths, cookies/assertions, and keys. Errors/logs are bounded and redacted. |
| Supply-chain drift | Base/image digests, ComfyUI commit, model revision/length/SHA, and dependencies are pinned and tested. |

Residual risk: RunPod container disks are not documented as encrypted at rest,
so Secure Cloud, minimal lifetime, deletion, and prohibition on unrelated data
are mandatory. RunPod, its proxy, registry, Hugging Face, and selected host
remain trusted; a provider/host compromise can access running data. Hard
expiry may interrupt generation or sync because cost containment wins.
