# `@traice-market/traicer`

The seller-operated Traicer command-line client. It creates local capture configuration, protects generated device secrets with [Varlock](https://varlock.dev/), scaffolds seller-owned S3-compatible storage through [Alchemy v2](https://v2.alchemy.run/), and starts the Traicer daemon on loopback-only listeners.

Traicer is an operator preview. It requires Bun 1.3 or newer, a Traice Market device credential, and scoped credentials for a dedicated S3-compatible bucket.

## Quick start

```sh
bunx @traice-market/traicer init \
  --storage cloudflare-r2 \
  --account-id <cloudflare-account-id> \
  --provider anthropic

# Fill the external credential fields in ~/.config/traicer/.env.local.
bunx @traice-market/traicer secrets
bunx @traice-market/traicer start
```

`init` creates files but does not deploy cloud resources unless you pass `--deploy` or confirm the interactive prompt. `--yes` accepts safe defaults and never implies `--deploy`.

## Commands

```text
traicer init [options]               Create configuration and optional storage infrastructure
traicer secrets [--directory PATH]   Encrypt plaintext .env.local secrets with Varlock
traicer start [--directory PATH]     Resolve secrets and run the local daemon
traicer --version                     Print the package version
traicer --help                        Show command help
```

The default directory is `~/.config/traicer`. `init` refuses to overwrite `traicer.config.json`, `.env.schema`, or `.env.local` in the target directory.

## Storage options

```sh
# Cloudflare R2
traicer init --storage cloudflare-r2 --account-id <account-id>

# AWS S3
traicer init --storage aws-s3 --region eu-west-2

# Existing S3-compatible storage
traicer init \
  --storage existing-s3 \
  --endpoint https://s3.example.com \
  --bucket traicer-data \
  --region us-east-1
```

Cloudflare R2 and AWS S3 modes generate an Alchemy stack under `<directory>/infra`. Existing S3 mode uses the supplied bucket and does not create infrastructure.

## Generated files

| File | Purpose |
| --- | --- |
| `traicer.config.json` | Non-secret provider, marketplace, device-public-key, and storage configuration |
| `.env.schema` | Varlock schema marking required and sensitive values |
| `.env.local` | External credentials plus encrypted references for generated device secrets |
| `.gitignore` | Excludes local secrets, Alchemy state, and generated dependencies |
| `infra/` | Optional Alchemy v2 stack for Cloudflare R2 or AWS S3 |

Do not commit `.env.local`, `.alchemy/`, or any plaintext credential. `traicer secrets` encrypts sensitive plaintext values in place; it does not fetch marketplace or storage credentials for you.

## Current routing limitation

`traicer start` prints a JSON ready record containing the random control and gateway ports. The fixed gateway also requires the generated adapter capability, and this release does not yet expose a dedicated command that prints the complete capability-bearing client endpoint.

Use the desktop app when you need a copyable gateway or explicit-proxy URL. CLI operators integrating the daemon directly should read the [client configuration guide](https://github.com/smashah/traicer/blob/main/docs/CLIENT_CONFIGURATION.md) and treat the adapter capability as a secret.

## More documentation

- [Full CLI reference](https://github.com/smashah/traicer/blob/main/docs/CLI.md)
- [Storage requirements](https://github.com/smashah/traicer/blob/main/docs/STORAGE.md)
- [Security model](https://github.com/smashah/traicer/blob/main/docs/THREAT_MODEL.md)
- [Troubleshooting](https://github.com/smashah/traicer/blob/main/docs/TROUBLESHOOTING.md)

Report non-sensitive bugs at [github.com/smashah/traicer/issues](https://github.com/smashah/traicer/issues). Report vulnerabilities through [GitHub private security advisories](https://github.com/smashah/traicer/security/advisories/new).
