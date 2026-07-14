# Traicer

[![npm](https://img.shields.io/npm/v/@traice-market/traicer)](https://www.npmjs.com/package/@traice-market/traicer)
[![GitHub release](https://img.shields.io/github/v/release/smashah/traicer?display_name=tag)](https://github.com/smashah/traicer/releases/latest)

Use Traicer to capture supported AI coding conversations you choose, protect them on your machine, and prepare them for sale through [Traice Market](https://traice.market). Your encrypted traces stay in S3-compatible storage you control; Traice Market receives signed inventory records and delivery commitments, not your raw prompts, source code, credentials, private object locations, or decryption keys.

> [!WARNING]
> Traicer is an operator preview. The macOS and Windows installers do not yet have production operating-system code signatures, and the macOS build is not notarised. Verify the [release checksums](https://github.com/smashah/traicer/releases/latest), start with non-sensitive work, and review the [release gates](docs/ROADMAP.md) before using it with production repositories.

## Before you start

You will need:

- A Traice Market seller account and device credential.
- An Anthropic or OpenAI provider credential. Your coding client continues to authenticate directly with the provider.
- A dedicated Cloudflare R2, AWS S3, or compatible S3 bucket with scoped credentials.
- Bun 1.3 or newer if you choose the CLI. The desktop app includes everything it needs to run the local service.

## Choose how to run Traicer

Start with the desktop app if this is your first time using Traicer. It guides you through setup, keeps secrets in your operating-system credential vault, and gives you a complete URL to copy into your coding client.

Choose the CLI when you want file-based configuration or need to generate Cloudflare R2 or AWS S3 infrastructure. The current CLI is intended for operators: it starts the capture service, but it does not yet print the complete capability-bearing gateway URL you need for routine client setup.

| | Desktop app | CLI |
| --- | --- | --- |
| Download | [Latest GitHub release](https://github.com/smashah/traicer/releases/latest) | `bunx @traice-market/traicer` |
| Secrets | Operating-system credential vault | Varlock-encrypted values in `.env.local` |
| Best for | Guided setup and everyday capture | Repeatable setup and storage scaffolding |

## Make your first capture with the desktop app

1. **Download the installer.** Choose the DMG for your Mac architecture, the setup EXE or MSI for Windows, or the DEB for Debian or Ubuntu. The `.app.tar.gz` files and `latest.json` on the release page are updater assets, not installers.
2. **Verify the download.** Compare the installer's SHA-256 digest with the checksum published on the release before opening it.
3. **Connect your accounts and storage.** Enter your Traice Market device credential, provider, bucket endpoint, bucket name, region, and scoped storage credentials.
4. **Start Traicer.** Select **Authorise device and start**. Traicer checks your storage and privacy configuration before it starts accepting capture traffic.
5. **Connect your coding client.** Copy the gateway URL shown in Traicer and use it as your client's provider base URL. Keep your normal Anthropic or OpenAI API key configured in the client.
6. **Send a supported request.** After the provider responds successfully, check **Local trace lifecycle** in Traicer for the new safe trace summary.

For Claude Code, start a session with the gateway URL shown by Traicer:

```sh
ANTHROPIC_BASE_URL='<gateway-url-shown-by-traicer>' claude
```

The gateway URL contains a local capability, so treat it like a credential. Do not commit it, add it to a shared shell profile, or include it in screenshots and issues. See [Client configuration](docs/CLIENT_CONFIGURATION.md) for OpenAI-compatible clients and explicit-proxy setup.

## Use the CLI

Generate a configuration and a Cloudflare R2 infrastructure project without deploying it:

```sh
bunx @traice-market/traicer init \
  --storage cloudflare-r2 \
  --account-id <cloudflare-account-id> \
  --provider anthropic
```

Add your marketplace and storage credentials to `~/.config/traicer/.env.local`, then protect the secret values and start Traicer:

```sh
bunx @traice-market/traicer secrets
bunx @traice-market/traicer start
```

`init` will not overwrite an existing configuration. It creates cloud resources only when you pass `--deploy` or approve the interactive deployment prompt; `--yes` does not grant deployment permission. Read the [CLI reference](docs/CLI.md) before using this path for capture.

## Know what will be captured

Traicer captures only traffic you deliberately route through its loopback gateway or explicit proxy. It does not scan your processes, inject itself into coding tools, change your system proxy, or capture arbitrary network traffic.

| Provider | Captured after a successful response | Not captured |
| --- | --- | --- |
| Anthropic | `POST /v1/messages` | Token counting and model lookup |
| OpenAI | `POST /v1/responses`, `POST /v1/chat/completions` | Embeddings and model lookup |

Before an accepted trace leaves your machine, Traicer strips secrets, applies your redaction policy, and encrypts the result with AES-256-GCM. It writes the ciphertext directly to your bucket and sends a signed, content-free inventory record to Traice Market.

If the provider request succeeds but a later capture step fails, Traicer leaves the provider response alone and creates no marketable trace. Capturing a trace does not commit a dataset, accept a sale, or prepare a delivery automatically: those actions require your explicit approval in Traicer.

## Get help

- Follow [Getting started](docs/GETTING_STARTED.md) for the full setup walkthrough.
- Use [Desktop app](docs/DESKTOP.md) for installation, local CA trust, updates, and capture controls.
- Use [Storage](docs/STORAGE.md) to prepare Cloudflare R2, AWS S3, or another S3-compatible service.
- Work through [Troubleshooting](docs/TROUBLESHOOTING.md) when startup, routing, or capture fails.
- Browse the [documentation index](docs/README.md) for the CLI, security model, architecture, and maintainer guides.

For reproducible bugs that contain no sensitive data, open a [GitHub issue](https://github.com/smashah/traicer/issues). Report vulnerabilities through [GitHub's private security advisory flow](https://github.com/smashah/traicer/security/advisories/new).

Never include raw traces, prompts, source code, credentials, private keys, storage URLs, capability-bearing gateway URLs, or unredacted diagnostics in a public issue. Read the [security policy](SECURITY.md), [threat model](docs/THREAT_MODEL.md), and [telemetry contract](docs/TELEMETRY.md) before using Traicer with sensitive repositories.

## Licence status

The source is public for inspection, but no distribution licence has been selected. No `LICENSE` file is included, so normal copyright applies. Do not describe Traicer as open source or redistribute its packages until a licence is published.
