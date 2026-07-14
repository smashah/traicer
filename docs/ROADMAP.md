# Roadmap and release gates

## Implemented in source

- **Executable and private control plane:** stdin bootstrap, separate capability-protected loopback listeners, Effect pause/resume, SQLite integrity/outbox, safe SSE/diagnostics, Tauri tray, OS vault, autostart, restart budget, and native sidecar supervision.
- **Capture and privacy:** OpenAI Responses/Chat Completions and Anthropic Messages fixed-upstream gateways, an authenticated explicit proxy with absolute-form HTTP, `CONNECT`, non-target blind tunnels, selective exact-host TLS, HTTP/1.1 and HTTP/2, opt-in current-user CA trust, exact allowlists, streaming-safe forwarding, structured and detector redaction, deterministic canonical traces, AES-256-GCM envelopes, and Ed25519 signatures.
- **Sovereign storage and marketplace:** SigV4 S3 write/head/full-read/delete/presign conformance, durable resumable multipart uploads, safe manifest reconciliation, signed deletion/tombstones, aggregate inventory, signed dataset/agreement work, X25519 buyer delivery, and durable expiry cleanup.
- **Build pipeline:** TypeScript and Rust checks, package/integration/security tests, native daemon compilation, Tauri debug packaging, Bumpy version PRs and generated changelogs, provenance-backed npm CLI publishing, and follow-on multi-platform desktop packaging with checksums, CycloneDX SBOMs, attestations, and signed updater metadata.

## Required before an endorsed release

1. Select the distribution licence and complete dependency-obligation review.
2. Provision production Apple/Windows signing and Apple notarisation, then verify the configured Tauri updater key and feed through an actual published release from the protected release environment.
3. Generate exact signed artefacts and verify install, first run, update, rollback, uninstall, vault behaviour, crash recovery, and settings restoration on clean macOS, Windows, and Linux machines.
4. Run live OpenAI/Anthropic and selected S3-provider compatibility fixtures, including streaming, corruption, expiry, deletion, revocation, and packet-capture checks.
5. Complete an independent security/privacy review and resolve every release-blocking finding.

## Post-launch privileged capabilities

Managed OS proxy/PAC configuration and native transparent redirection remain separate opt-in milestones. They require platform-specific privileged helpers, crash-safe restoration, certificate-trust controls, pinning/ECH policy, and additional external review. They are not hidden inside the ordinary fixed-upstream release.
