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
3. Open Traicer and enter the provider, S3 endpoint, bucket, prefix, signing region, and scoped storage credentials. Add a marketplace credential when you want immediate marketplace reconciliation; leave it empty for local-first capture.
4. Select **Authorise device and start** when a marketplace credential is configured. Otherwise, select **Start local-first capture**. Both paths check the bucket with a write/head/read/delete probe, run a synthetic privacy-pipeline dry run, and start the loopback daemon only after those checks pass. The authorised path also registers the device and signed capture policy; the local-first path retains signed manifests in the durable local outbox for later reconciliation.
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

`status` confirms that the daemon is running and the storage checks passed. From the repository you want to capture, link the project once and launch a supported client through a temporary scoped route:

```sh
bunx @traice-market/traicer project link
bunx @traice-market/traicer run -- claude
```

After the client completes a successful supported request, verify the capture without revealing its contents:

```sh
bunx @traice-market/traicer traces list
bunx @traice-market/traicer explore
```

The trace should appear in both the list and the explorer. Substitute `codex` or `opencode` for `claude` when that is the client you use. Run `traicer urls --reveal` only when you need to configure a client manually; it prints a capability-bearing URL.

## Confirm what stays where

A valid first capture should produce ciphertext in the seller bucket, a safe local trace summary, and a signed content-free manifest. When a marketplace account is connected, Traicer submits that manifest for reconciliation; otherwise, it retains the manifest in the durable local outbox. Neither path should place a raw prompt, response, provider key, bucket credential, private object key, or presigned URL in marketplace traffic, diagnostics, or logs.

If startup or capture fails, keep the provider workflow separate from the investigation and use [Troubleshooting](TROUBLESHOOTING.md). Never paste raw traces or credentials into a public issue.
