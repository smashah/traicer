# Traicer documentation

Traicer is the local seller-side service for capturing, protecting, storing, and delivering eligible AI coding traces. Start with the user guides if you are installing Traicer; use the architecture and maintainer references when you are reviewing or changing the implementation.

## Use Traicer

1. [Getting started](GETTING_STARTED.md) — choose the desktop app or CLI and make the first capture.
2. [Desktop app](DESKTOP.md) — install, configure, update, and control the native preview.
3. [CLI reference](CLI.md) — commands, options, files, and Varlock behaviour.
4. [Client configuration](CLIENT_CONFIGURATION.md) — route supported AI clients through Traicer.
5. [Storage](STORAGE.md) — prepare Cloudflare R2, AWS S3, or another S3-compatible service.
6. [Troubleshooting](TROUBLESHOOTING.md) — diagnose setup, storage, routing, and capture failures.

## Understand the security design

- [Threat model](THREAT_MODEL.md) defines the assets, assumptions, controls, and excluded threats.
- [Telemetry contract](TELEMETRY.md) defines what may and may not leave the seller device.
- [Architecture](ARCHITECTURE.md) explains the Tauri shell, Bun daemon, storage, marketplace, and delivery flow.
- [Sidecar process ADR](adr/0001-tauri-bun-sidecar.md) records why the native shell supervises a Bun sidecar.

## Repository layout

- `apps/cli` — the published `@traice-market/traicer` package: file-based initializer, secret encryption, daemon launcher, and owner trace access.
- `apps/daemon` — the loopback capture daemon, compiled into a standalone Bun sidecar for the desktop app.
- `apps/desktop` — the Tauri shell and React webview that supervise the sidecar and hold OS-vault secrets.
- `packages/` — shared workspace packages: `domain`, `capture-core`, `privacy-pipeline`, `crypto`, `storage-s3`, `state-sqlite`, `trace-reader`, `marketplace-client`, `api-contract`, and `effect-runtime`.
- `tooling/` — internal build configuration shared across the workspace.

## Maintain and release Traicer

- [Release workflow](RELEASING.md) covers Bumpy, npm provenance, desktop builds, signing, and GitHub assets.
- [Roadmap and release gates](ROADMAP.md) separates implemented source from evidence still required for an endorsed release.
- [Security policy](../SECURITY.md) explains how to report a vulnerability without exposing seller data.

The source is public for inspection but currently has no distribution licence. Do not describe it as open source or redistribute it until the repository includes a licence.
