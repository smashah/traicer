# Traicer

Traicer is the public, seller-operated companion to
[Traice Market](https://traice.market). It is designed to capture eligible
coding-agent interactions locally, redact and encrypt accepted traces on the
seller's machine, upload ciphertext directly to seller-owned S3-compatible
storage, and send only signed, content-free commitments to the marketplace.

This repository now has a tested pre-release OpenAI vertical slice. The Bun/Hono
daemon forwards fixed-upstream Responses and Chat Completions traffic, applies a
deny-by-default capture policy, redacts and canonicalises accepted exchanges,
encrypts each trace with an authenticated per-trace envelope, uploads through a
SigV4 S3-compatible client with full readback verification, signs a content-free
manifest with Ed25519, and durably retries marketplace submission through SQLite.

It is not a distributable release yet. Anthropic capture, production OS-vault
brokering, live desktop state, signed native installers, SBOM/provenance, and
external security review remain open milestones.

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
{"protocolVersion":1,"controlToken":"<32+ random characters>","vaultKey":"<base64url 256-bit key>","capture":{"adapterCapability":"<unguessable local capability>","bucketAlias":"<safe alias>","client":"codex","deviceId":"<registered device UUID>","marketplace":{"apiBaseUrl":"https://api.traice.market","credential":"<manifest capability>"},"policy":{"allowedPaths":["/v1/responses","/v1/chat/completions"],"capturePolicyId":"<active policy UUID>","pipelineVersion":"pipeline/1","policyVersion":"policy/1","redactionProfile":"strict-default"},"signerKeyId":"<registered signing-key fingerprint>","signingPrivateKey":"<Ed25519 private key>","storage":{"accessKeyId":"<seller storage key ID>","addressingStyle":"path","bucket":"<seller bucket>","endpoint":"https://<seller S3 endpoint>","prefix":"traice","secretAccessKey":"<seller storage secret>","signingRegion":"auto","storageCapabilityProfileId":"<tested profile>"},"upstreamOrigin":"https://api.openai.com"}}
```

The `capture` object may be omitted for control-only diagnostics. With capture
configured, the daemon binds separate random loopback control and gateway ports
and emits one sanitised ready line. The desktop shell will own creation and
one-use transfer of this bootstrap material before the first native release.

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
