# `@traice-market/traicer`

The seller-operated Traicer command-line client. It creates local capture configuration, protects generated device secrets with [Varlock](https://varlock.dev/), scaffolds seller-owned S3-compatible storage through [Alchemy v2](https://v2.alchemy.run/), and starts the Traicer daemon on loopback-only listeners.

Traicer is an operator preview. It requires Bun 1.3 or newer, a Traice Market device credential, and scoped credentials for a dedicated S3-compatible bucket.

## Quick start

```sh
bunx @traice-market/traicer init \
  --storage cloudflare-r2

# Fill the external credential fields in ~/.config/traicer/.env.local.
bunx @traice-market/traicer secrets
bunx @traice-market/traicer start

# In another terminal, from the repository you want to capture:
bunx @traice-market/traicer project link
bunx @traice-market/traicer run -- claude
```

`init` creates files but does not deploy cloud resources unless you pass `--deploy` or confirm the interactive prompt. `--yes` accepts safe defaults and never implies `--deploy`.

Traicer generates Anthropic and OpenAI adapter routes over one storage bucket. Your coding client keeps its existing provider credentials. These routes have unit and synthetic coverage, but released provider and harness combinations haven't been acceptance-tested yet.

## Commands

```text
traicer init [options]               Create configuration and optional storage infrastructure
traicer project link|status|unlink   Manage this repository's private local scope link
traicer run -- <harness> [args]      Generate a scoped launch for claude, codex, or opencode
traicer secrets [--directory PATH]   Encrypt plaintext .env.local secrets with Varlock
traicer start [--directory PATH]     Resolve secrets and run the local daemon
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

Do not commit `.env.local`, `.alchemy/`, or any plaintext credential. `traicer secrets` encrypts sensitive plaintext values in place; it does not fetch marketplace or storage credentials for you.

## Project-scoped capture

`traicer project link` derives a keyed fingerprint from the Git `origin` and stores only that fingerprint and an opaque project scope UUID. Repository names, remotes, and local paths aren't written to Traicer state or sent to the marketplace.

`traicer run` generates scoped launch settings for `claude`, `codex`, and `opencode`. These integrations currently have unit and synthetic evidence only; compatibility with released harness binaries hasn't been acceptance-tested. The CLI attempts to revoke the route when the child exits. If revocation fails, it warns; the route remains valid for up to 12 hours or until the daemon stops.

## More documentation

- [Full CLI reference](https://github.com/smashah/traicer/blob/main/docs/CLI.md)
- [Storage requirements](https://github.com/smashah/traicer/blob/main/docs/STORAGE.md)
- [Security model](https://github.com/smashah/traicer/blob/main/docs/THREAT_MODEL.md)
- [Troubleshooting](https://github.com/smashah/traicer/blob/main/docs/TROUBLESHOOTING.md)

Report non-sensitive bugs at [github.com/smashah/traicer/issues](https://github.com/smashah/traicer/issues). Report vulnerabilities through [GitHub private security advisories](https://github.com/smashah/traicer/security/advisories/new).
