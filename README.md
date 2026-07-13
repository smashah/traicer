# Traicer

Traicer is the public, seller-operated companion to
[Traice Market](https://traice.market). It is designed to capture eligible
coding-agent interactions locally, redact and encrypt accepted traces on the
seller's machine, upload ciphertext directly to seller-owned S3-compatible
storage, and send only signed, content-free commitments to the marketplace.

This repository is at Milestone 0: the executable and process-boundary spike.
It contains the strict pnpm/Turborepo workspace, a Bun/Hono loopback daemon,
Effect-owned pause/resume state, SQLite migration zero, a cross-runtime crypto
known-answer test, and the initial Tauri tray shell. It does not yet capture real
provider traffic, connect object storage, submit marketplace inventory, or ship
signed installers.

## Trust boundary

- Raw trace bodies never go to Traice-controlled systems.
- Storage credentials and private keys remain in the local vault boundary.
- Capture is explicit and deny-by-default.
- Unsafe or unknown data is forwarded to the provider but excluded from
  persistence.
- A device signature is a seller commitment, not proof of provider origin,
  ownership, legality, or training suitability.

## Development

Install Bun, Rust, the Tauri platform prerequisites, and pnpm 10.28 or newer.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @traice/daemon build
```

The daemon expects one JSON bootstrap document on stdin and never accepts
secrets through arguments, environment variables, files, or stdout:

```json
{"protocolVersion":1,"controlToken":"<32+ random characters>","vaultKey":"<base64url 256-bit key>"}
```

After bootstrap it binds a random loopback control port and emits one sanitised
ready line. The desktop shell will own creation and transfer of this bootstrap
material before the first development release.

## Repository roadmap

The implementation sequence is documented in [docs/ROADMAP.md](docs/ROADMAP.md).
Architecture and privacy boundaries are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). Please read
[SECURITY.md](SECURITY.md) before reporting a vulnerability.

## Licence status

The source is public for inspection, but an open-source licence has not yet been
selected. No `LICENSE` file is included, so normal copyright applies until the
founder completes the licence and dependency-obligation review. This repository
does not describe the current spike as a distributable open-source release.
