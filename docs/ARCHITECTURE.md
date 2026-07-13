# Architecture

The Tauri shell owns the tray, single-instance lifecycle, OS credential vault, autostart preference, crash-loop budget, and Bun sidecar supervision. The React webview invokes narrow native commands and never receives the daemon token, marketplace credential, local wrapping key, seller-storage secret, or device signing key.

The compiled Bun sidecar owns three separately authorised loopback surfaces:

- A random-port Hono control API protected by a random bearer capability. It exposes bounded health, status, safe trace summaries, events, diagnostics, pause/resume, marketplace work, dataset commitment, agreement proposal, and delivery preparation.
- A random-port fixed-upstream gateway whose URL includes a separate adapter capability. OpenAI Responses/Chat Completions and Anthropic Messages are allowlisted; arbitrary paths and providers are rejected.
- A random-port explicit HTTP/HTTPS proxy protected by the adapter capability. Absolute-form HTTP and `CONNECT` are supported; non-target TLS is blind-tunnelled, while exact supported provider hosts can use opt-in local-CA TLS termination with HTTP/1.1 or HTTP/2.

```text
coding client -> loopback gateway or explicit proxy -> fixed provider upstream
                       |
                       v
 signed policy -> redaction -> canonical trace -> local AES-GCM
                       |                              |
                       |                              v
                       |                       seller-owned S3
                       v
              Ed25519 safe manifest -> Traice control plane

seller request -> local dataset root -> signed agreement
                       |
                       v
 local decrypt/re-encrypt -> short seller URL -> X25519 buyer capability
                                                  |
                                                  v
                                         opaque Traice envelope
```

Provider forwarding is fail-open when local persistence fails, because a telemetry failure must not break the configured coding client. Persistence is fail-closed: unknown policy, parser, redaction, storage, or signing state creates no trace object or manifest.

The daemon runs a seller-storage conformance probe and a synthetic redaction/canonicalisation dry run before capture becomes enabled. SQLite records trace lifecycle, durable multipart uploads, a safe-manifest outbox, signed deletion/tombstone work, bounded content-free events, and temporary delivery objects. Startup reconciles pending manifests and multipart completion, then deletes expired delivery objects; a one-minute cleanup loop retries storage failures without logging object locations.

The Tauri shell generates a private local CA and exact-host leaf certificates, stores private material in the OS credential vault, and passes only the leaf material required by the daemon through the one-use bootstrap. Installing or removing CA trust is an explicit current-user action. The ordinary client never changes system proxy settings or installs a native redirector.

Dataset preparation selects exact locally committed canonical hashes, computes the deterministic dataset root, and signs it. Delivery decrypts only on the seller machine, re-encrypts the selected traces under a per-delivery key, uploads temporary ciphertext, issues 15-minute read capabilities, wraps the capability to the buyer's X25519 key, and submits only the opaque envelope and safe header to Traice.
