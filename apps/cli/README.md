# `@traice-market/traicer`

The seller-operated Traicer command-line client. It creates local capture configuration, protects generated device secrets with [Varlock](https://varlock.dev/), scaffolds seller-owned S3-compatible storage through [Alchemy v2](https://v2.alchemy.run/), and starts the Traicer daemon on loopback-only listeners.

Traicer is an operator preview. It requires Bun 1.3 or newer and scoped credentials for a dedicated S3-compatible bucket. A Traice Market device credential is optional at capture time; without one, signed manifests remain pending locally for later reconciliation.

## Quick start

```sh
bunx @traice-market/traicer init \
  --storage cloudflare-r2

# Fill the external credential fields in ~/.config/traicer/.env.local.
bunx @traice-market/traicer secrets
bunx @traice-market/traicer start --detach
bunx @traice-market/traicer status

# In another terminal, from the repository you want to capture:
bunx @traice-market/traicer project link
bunx @traice-market/traicer run -- claude
```

`init` creates files and optionally deploys storage; it never starts a proxy or background service. `--yes` accepts safe defaults and never implies `--deploy`. Use `start --detach` after secrets are ready, then `status`, `urls`, and `instructions` to discover the running service safely.

Initialization is AI-provider agnostic: Traicer generates Anthropic and OpenAI adapter routes over one storage bucket. Your coding client keeps its existing provider credentials. Claude Code 2.1.212 on macOS has been manually acceptance-tested through the Anthropic route; OpenAI and the other harness combinations currently have unit and synthetic evidence.

## Commands

```text
traicer init [options]               Create configuration and optional storage infrastructure
traicer reset [--yes] [--state-store] Destroy managed storage and remove generated local state
traicer project link|status|unlink   Manage this repository's private local scope link
traicer run -- <harness> [args]      Generate a scoped launch for claude, codex, or opencode
traicer secrets [--directory PATH]   Encrypt plaintext .env.local secrets with Varlock
traicer start [--directory PATH] [--detach] Resolve secrets and run the local daemon
traicer stop [--directory PATH]      Stop a detached daemon through its authenticated control API
traicer status [--json]              Show safe daemon, storage, and reconciliation health
traicer urls [--reveal] [--json]     Discover gateway URLs; mint bearer URLs only with --reveal
traicer instructions [--reveal]      Print copy-ready setup for Claude, Codex, and OpenCode
traicer traces list [--json]         List bounded local lifecycle metadata
traicer traces show <id|object-key>  Lazily download, verify, decrypt, and print one trace
traicer traces export <id|object-key> --output PATH  Write an owner-only plaintext file
traicer traces cache status|clear    Inspect or explicitly clear decrypted cache entries
traicer explore                      Open the interactive Traices Explorer TUI
traicer --version                     Print the package version
traicer --help                        Show command help
```

The default directory is `~/.config/traicer`. `init` refuses to overwrite `traicer.config.json`, `.env.schema`, or `.env.local` in the target directory.

## Storage options

```sh
# Cloudflare R2
traicer init --storage cloudflare-r2

# AWS S3
traicer init --storage aws-s3 --region eu-west-2

# Existing S3-compatible storage
traicer init \
  --storage existing-s3 \
  --endpoint https://s3.example.com \
  --bucket traicer-data \
  --region us-east-1
```

Cloudflare R2 and AWS S3 modes generate an Alchemy stack under `<directory>/infra`. For R2, Traicer tries to read the public account list from an installed, authenticated Wrangler CLI; `--account-id` remains available as an explicit override. The selection is written into the R2 endpoint and generated stack, while Alchemy handles deployment authentication separately. Existing S3 mode uses the supplied bucket and does not create infrastructure.

## Generated files

| File | Purpose |
| --- | --- |
| `traicer.config.json` | Non-secret provider, marketplace, device-public-key, and storage configuration |
| `.env.schema` | Varlock schema marking required and sensitive values |
| `.env.local` | External credentials plus encrypted references for generated device secrets |
| `.gitignore` | Excludes local secrets, Alchemy state, and generated dependencies |
| `infra/` | Optional Alchemy v2 stack for Cloudflare R2 or AWS S3 |

Do not commit `.env.local`, `.alchemy/`, or any plaintext credential. `traicer secrets` encrypts sensitive plaintext values in place; it does not fetch marketplace or storage credentials for you. The marketplace field may remain empty, but storage credentials are required because capture never reports success without durable ciphertext.

## Project-scoped capture

`traicer project link` derives a keyed fingerprint from the Git `origin` and stores only that fingerprint and an opaque project scope UUID. Repository names, remotes, and local paths aren't written to Traicer state or sent to the marketplace.

`traicer run` generates scoped launch settings for `claude`, `codex`, and `opencode`. Claude Code 2.1.212 on macOS has been manually acceptance-tested; Codex and OpenCode currently have unit and synthetic evidence. The CLI attempts to revoke the route when the child exits. If revocation fails, it warns; the route remains valid for up to 12 hours or until the daemon stops.

## Owner trace access

The owner-access commands read the local WAL-mode inventory directly, so they work while capture and traice.market are offline. `traces show`, `traces export`, and `explore` accept a known local trace ID, ciphertext hash, or exact configured content-addressed object key, such as `traices/objects/v1/ab/<sha256>.trce`; arbitrary bucket reads are rejected.

Inspection downloads only the selected ciphertext, verifies its SHA-256, decrypts with the Varlock-resolved vault key, verifies the canonical hash, and validates the canonical trace schema. Decrypted entries are compressed under `<directory>/cache/decrypted`, capped at 512 MiB, and deleted after seven days. POSIX cache files use mode `0600`; Windows relies on the user's profile ACL. CLI and daemon startup, cache access, cache writes, and the daemon's periodic sweep prune stale entries; `traicer traces cache clear` removes them immediately. Plaintext printed to a terminal, copied to a clipboard, shown in the TUI, or explicitly exported remains sensitive.

## More documentation

- [Full CLI reference](https://github.com/smashah/traicer/blob/main/docs/CLI.md)
- [Storage requirements](https://github.com/smashah/traicer/blob/main/docs/STORAGE.md)
- [Security model](https://github.com/smashah/traicer/blob/main/docs/THREAT_MODEL.md)
- [Troubleshooting](https://github.com/smashah/traicer/blob/main/docs/TROUBLESHOOTING.md)

Report non-sensitive bugs at [github.com/smashah/traicer/issues](https://github.com/smashah/traicer/issues). Report vulnerabilities through [GitHub private security advisories](https://github.com/smashah/traicer/security/advisories/new).
