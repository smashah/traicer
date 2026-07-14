# Traicer

Traicer is the public, seller-operated local client for [Traice Market](https://traice.market). It captures only explicitly configured AI-provider traffic, redacts and canonicalises accepted exchanges locally, encrypts them into seller-owned S3-compatible storage, and sends only signed content-free commitments to the marketplace.

This repository contains a pre-release client, not an endorsed installer. OpenAI Responses/Chat Completions and Anthropic Messages gateways, an authenticated explicit HTTP/HTTPS proxy, selective exact-host TLS capture with opt-in current-user CA trust, the Tauri desktop shell, OS credential vault, resumable storage transfer, deletion/tombstones, durable marketplace work, direct buyer-encrypted delivery, and signed Tauri updates are implemented. A distribution licence, production Apple/Windows signing and Apple notarisation, published update-feed verification, clean-machine release verification, live compatibility evidence, and external security review are still required before an endorsed release.

## CLI release target

The first distribution target is the `@traice-market/traicer` npm CLI; native DMG and Windows installers follow each published CLI release. The guided initializer creates seller configuration, protects generated device secrets with [Varlock](https://varlock.dev/), and can scaffold Cloudflare R2 or AWS S3 through [Alchemy v2](https://v2.alchemy.run/) while also supporting an existing S3-compatible service.

```sh
bunx @traice-market/traicer init --storage cloudflare-r2 --account-id <account-id>
# add the marketplace and storage credentials, then encrypt them in place
bunx @traice-market/traicer secrets
bunx @traice-market/traicer start
```

Storage deployment requires an explicit `--deploy` flag or interactive confirmation. The initializer never treats `--yes` as permission to create cloud resources, and it writes generated private values only as encrypted Varlock references.

## Trust boundary

- Provider traffic is forwarded through a fixed upstream and exact method/path allowlist; capture persistence fails closed while provider forwarding fails open.
- The explicit proxy requires a per-install loopback capability, blind-tunnels non-target `CONNECT` traffic, and terminates TLS only for exact supported provider hosts after the user explicitly trusts the generated CA. Denied paths are forwarded without entering capture, storage, logs, or telemetry.
- Redaction runs before deterministic canonicalisation, hashing, encryption, local persistence, or marketplace egress.
- Raw trace bodies, reusable storage credentials, private keys, plaintext delivery capabilities, and private object locations never enter Traice-controlled systems.
- Ciphertext is written directly to the seller's bucket and verified by metadata plus a full readback.
- Safe manifests, readiness checks, inventory, dataset roots, agreements, envelopes, and receipts are signed commitments. They do not prove provider origin, ownership, legality, usefulness, or payment outside the verified integrated flow.

## Implemented flow

```text
configured coding client
  -> loopback fixed-upstream gateway or authenticated explicit proxy
  -> provider response returned unchanged
  -> deny-default policy + secret stripping + redaction
  -> canonical trace + AES-256-GCM envelope
  -> seller S3 write/head/full-read verification
  -> Ed25519 safe manifest + durable Drizzle/Bun SQLite outbox
  -> Traice inventory/request work
  -> immutable dataset and agreement signatures
  -> per-delivery re-encryption + 15-minute seller URLs
  -> X25519 buyer-encrypted capability submitted to Traice
```

Large seller-storage objects use a durable multipart journal so interrupted uploads resume without restarting completed parts. Expired temporary delivery objects are durably tracked and deleted from seller storage. A local trace deletion removes seller ciphertext, submits a signed marketplace tombstone, then erases local object references. The buyer application unwraps the capability locally, downloads directly from seller storage, verifies ciphertext and canonical hashes, and submits an Ed25519 receipt.

## Desktop security model

The Tauri shell stores configuration, the marketplace credential, Ed25519 private key, seller-storage secret, and local wrapping key in the operating-system credential vault. The React webview receives only safe configuration/status. A one-use stdin bootstrap carries secrets to the native Bun daemon; secrets never use process arguments, environment variables, stdout, diagnostic exports, or marketplace payloads.

The desktop supports pause/resume, loopback health, marketplace work, dataset commitment, seller agreement proposal, delivery preparation, trace deletion, explicit proxy configuration, opt-in CA trust and removal, launch-at-login, and a three-start/five-minute crash-loop budget. Managed PAC/system proxy changes and native transparent redirection are separate privileged modes and are not silently installed by this release.

## Development and verification

Install Node 24, pnpm 10.28.1, Bun, Rust 1.88, and the Tauri platform prerequisites.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --all-targets -- -D warnings
```

CI also compiles the native daemon, creates an unsigned debug Linux package, and rejects imports from reference source trees. Bumpy generates package versions and changelogs, publishes the CLI with npm provenance, and creates the GitHub release before the desktop workflow builds and attaches updater-signed native previews. Platform code signing and notarisation are applied only after their credentials are configured.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Release workflow](docs/RELEASING.md)
- [Roadmap and release gates](docs/ROADMAP.md)
- [Telemetry contract](docs/TELEMETRY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Private vulnerability reporting](SECURITY.md)

## Licence status

The source is public for inspection, but no distribution licence has been selected. No `LICENSE` file is included, so normal copyright applies. Do not redistribute binaries or describe this repository as an open-source release until the founder completes the licence and dependency-obligation review.
