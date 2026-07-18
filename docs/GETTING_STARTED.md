# Getting started

This guide takes a seller from a clean machine to a first eligible capture. Traicer is currently an operator preview, so begin with a test provider account, a dedicated storage bucket, and non-sensitive work.

## Before you install

You need:

- A Traice Market seller account and device-scoped marketplace credential when you want immediate marketplace reconciliation. The CLI can capture to seller storage without an account and retain manifests locally.
- Provider credentials for Anthropic or OpenAI. They continue to authenticate directly with the provider; Traicer does not replace them.
- A dedicated Cloudflare R2, AWS S3, or S3-compatible bucket with the permissions listed in [Storage](STORAGE.md).
- Bun 1.3 or newer when using the CLI. The desktop app bundles its daemon.

## Choose the desktop app or CLI

Use the desktop app for the first setup. It stores secrets in the operating-system credential vault and shows copyable fixed-gateway and explicit-proxy URLs after startup.

Use the CLI for file-based configuration, automated initialization, Alchemy storage scaffolding, or command-driven service discovery.

## Desktop path

1. Download the package for your operating system from the [latest GitHub release](https://github.com/smashah/traicer/releases/latest). Use the Apple Silicon DMG for M-series Macs, the Intel DMG for Intel Macs, the setup EXE or MSI for Windows, and the DEB for Debian or Ubuntu.
2. Compare the package SHA-256 digest with the matching checksum file on the release. The installers are previews and may trigger Gatekeeper or SmartScreen because production OS signing and Apple notarisation are not configured yet.
3. Open Traicer and enter the marketplace credential, provider, S3 endpoint, bucket, prefix, signing region, and scoped storage credentials.
4. Select **Authorise device and start**. Traicer registers the device and signed capture policy, checks the bucket with a write/head/read/delete probe, runs a synthetic privacy-pipeline dry run, and starts the loopback daemon only after those checks pass.
5. Copy the displayed gateway URL and configure the AI client using [Client configuration](CLIENT_CONFIGURATION.md).
6. Send a successful request to a supported capture path. The **Local trace lifecycle** section should show a new safe trace summary after the request finishes.

## CLI path

```sh
bunx @traice-market/traicer init \
  --storage cloudflare-r2
```

Initialization is AI-provider agnostic: the generated configuration includes both Anthropic and OpenAI capture adapters over the same seller-owned storage. The client launched with `traicer run`, or the API path used with a revealed gateway URL, selects the adapter at runtime; your coding client keeps using its existing provider credentials.

If Wrangler is installed and authenticated, Traicer tries to list the public Cloudflare accounts returned by `wrangler whoami --json`. Choose the account ID to write into the R2 endpoint and generated Alchemy stack. If Wrangler is unavailable, enter the public account ID manually or pass it with `--account-id`. Alchemy authenticates independently when you deploy.

Edit `~/.config/traicer/.env.local` and fill the storage credential fields. Fill the marketplace credential when you have an account; otherwise leave it empty. Leave generated `varlock(...)` references unchanged, then run:

```sh
bunx @traice-market/traicer secrets
bunx @traice-market/traicer start --detach
bunx @traice-market/traicer status
```

`status` confirms the daemon and storage boundary. From the repository you want to capture, run `traicer project link` once and then use `traicer run -- claude`, `traicer run -- codex`, or `traicer run -- opencode` to launch a client through a temporary scoped route. Use `traicer urls --reveal` only when you need to configure a client manually; it prints a capability-bearing URL.

## Confirm the boundary

A valid first capture should produce ciphertext in the seller bucket, a safe local trace summary, and a signed content-free marketplace manifest. It should not place a raw prompt, response, provider key, bucket credential, private object key, or presigned URL in marketplace traffic, diagnostics, or logs.

If startup or capture fails, keep the provider workflow separate from the investigation and use [Troubleshooting](TROUBLESHOOTING.md). Never paste raw traces or credentials into a public issue.
