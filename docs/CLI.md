# CLI reference

`@traice-market/traicer` is the file-based Traicer initializer and local daemon launcher. It runs on Bun 1.3 or newer and uses the packaged Varlock CLI for secret encryption and resolution.

## Run without a global install

```sh
bunx @traice-market/traicer --help
```

You can also install the package with your normal npm-compatible package manager and run `traicer`, but Bun remains the required runtime.

## `traicer init`

`init` creates configuration under `~/.config/traicer` unless `--directory` is supplied. It stops if `traicer.config.json`, `.env.schema`, or `.env.local` already exists.

```text
--storage <backend>       cloudflare-r2, aws-s3, or existing-s3
--account-id <id>        Cloudflare account ID override for cloudflare-r2
--bucket <name>          Existing bucket name; required for existing-s3
--endpoint <url>         HTTPS S3-compatible endpoint; required for existing-s3
--region <region>        Signing region; R2 uses auto, other modes default to us-east-1
--marketplace-url <url>  Traice Market API base URL; defaults to https://api.traice.market
--directory <path>       Configuration directory
--deploy                 Install generated infra dependencies and run Alchemy deploy
--yes                    Accept safe defaults without granting deployment permission
```

When interactive input is available, omitted values are prompted. With `--yes`, required values without safe defaults remain empty and validation fails rather than inventing credentials or account identifiers.

Initialization is AI-provider agnostic. The generated configuration declares Anthropic and OpenAI adapter routes over one seller-owned storage configuration; the client or request path selects the adapter at runtime. See the [current acceptance evidence](../README.md#compatibility-and-preview-limits) for which client and provider combinations have end-to-end coverage.

## `traicer reset`

```sh
traicer reset [--directory <path>] [--yes] [--state-store]
```

`reset` destroys the generated Alchemy storage stack before removing Traicer's managed local files. It preserves the local configuration if cloud destruction fails. `--state-store` also removes Alchemy's account-level Cloudflare state store and is available only for Cloudflare R2 configurations.

### Cloudflare R2

```sh
traicer init \
  --storage cloudflare-r2
```

The Cloudflare account ID is public account metadata, not an API token. When `--account-id` is omitted, `init` tries `wrangler whoami --json`: one returned account is selected automatically, while multiple accounts are shown as a numbered choice. If Wrangler is missing or unauthenticated, `init` falls back to manual account ID entry.

Traicer writes the selected ID into the local R2 endpoint and generated Alchemy stack, and passes it as `CLOUDFLARE_ACCOUNT_ID` when you approve an immediate deployment. Alchemy still handles its own authentication and deployment process; Traicer does not extract or reuse Wrangler's OAuth token.

### AWS S3

```sh
traicer init \
  --storage aws-s3 \
  --region eu-west-2
```

This generates a private, versioned, server-side-encrypted bucket definition. Deployment still requires AWS credentials understood by Alchemy and explicit deployment approval.

### Existing S3-compatible storage

```sh
traicer init \
  --storage existing-s3 \
  --endpoint https://s3.example.com \
  --bucket traicer-data \
  --region us-east-1
```

This mode creates no infrastructure. Traicer requires HTTPS outside loopback development and uses path-style addressing for an existing compatible service.

## `traicer secrets`

```sh
traicer secrets [--directory <path>]
```

This runs Varlock encryption against `.env.local`. Before running it, fill these external values:

```text
TRAICER_MARKETPLACE_CREDENTIAL     optional
TRAICER_STORAGE_ACCESS_KEY_ID
TRAICER_STORAGE_SECRET_ACCESS_KEY
TRAICER_STORAGE_SESSION_TOKEN      optional
```

The initializer already writes encrypted Varlock references for the control token, device signing key, local envelope-wrapping key, and project-mapping key. Do not replace those references with plaintext.

Without a marketplace credential, startup still performs the mandatory seller-storage and local privacy checks, captures encrypted traces, and keeps signed manifests in the durable local outbox for later reconciliation.

`init` does not start capture, a provider gateway, or an explicit proxy. It only creates configuration and optionally deploys storage.

## `traicer start` and `traicer stop`

```sh
traicer start [--directory <path>] [--detach]
traicer stop [--directory <path>]
```

`start` resolves Varlock values, sends the bootstrap to the daemon once over stdin, and removes `TRAICER_*` values from the daemon process environment. The daemon binds its control and provider gateway listeners to `127.0.0.1` on random ports.

On success it prints a JSON record similar to:

```json
{"controlPort":49152,"gatewayPort":49153,"proxyPort":null,"pid":12345,"protocolVersion":2,"type":"ready"}
```

Without `--detach`, the daemon owns the foreground terminal. With `--detach`, Traicer waits for authenticated readiness, leaves the daemon running in the background, and returns; repeated detached starts are idempotent. `stop` uses the authenticated loopback shutdown path and is also idempotent.

The control API requires a separate bearer capability and is not a public integration surface. Do not expose either loopback listener through a tunnel, container port mapping, LAN bind, or reverse proxy.

## Service discovery

`traicer status [--json]` reports safe daemon, storage, capture, marketplace-connection, and pending-manifest state. `traicer urls` shows the loopback gateway without minting a route; `traicer urls --reveal` creates and prints a 12-hour project-scoped bearer route for direct SDK use. `traicer instructions` prefers `traicer run -- claude|codex|opencode`, so route tokens are not persisted in shell history.

## Owner trace access

```sh
traicer traces list [--limit 50] [--offset 0] [--provider openai] [--client claude] [--state committed] [--since 2026-07-01T00:00:00Z] [--json]
traicer traces show <trace-id|configured-object-key|ciphertext-hash> [--json] [--stdout]
traicer traces export <selector...> --output ./traces.jsonl [--format json|jsonl|markdown] [--force]
traicer traces cache status|clear
traicer explore
```

These commands read the local WAL-mode inventory directly, so listing, exploring, exporting, and cache management continue to work while the capture daemon and traice.market are offline. Only a reveal or export fetches ciphertext from seller storage. The reader accepts known trace IDs, ciphertext hashes, and exact content-addressed keys already recorded under the configured prefix; it cannot read arbitrary S3 keys. Ciphertext and canonical hashes are verified and the canonical schema is validated before plaintext is returned. Interactive `show` requires typing `reveal`; redirected output requires the deliberate `--stdout` flag.

The OpenTUI explorer downloads lazily and shows download/decrypt progress. Successfully inspected plaintext is gzip-compressed in `<directory>/cache/decrypted`, limited to 512 MiB by default, and removed after seven days. POSIX cache files use mode `0600`; Windows relies on the user's profile ACL. Set `TRAICER_PLAINTEXT_CACHE_MAX_BYTES` to a non-negative byte limit when launching Traicer to change the size bound. CLI startup, daemon startup, the daemon's periodic sweep, cache reads, and cache writes prune stale entries, while `traces cache clear` removes all entries immediately. Terminal output, explicitly confirmed clipboard copies, the desktop/TUI detail pane, and exported files contain sensitive plaintext.

## `traicer project`

Run `traicer project link` inside a Git repository with an `origin` remote. Traicer stores an HMAC fingerprint and opaque UUID in the config directory; it doesn't persist the remote, repository name, or directory. Pass `--scope-id <uuid>` when linking the same project on another machine.

## `traicer run`

`traicer run` generates scoped launch settings for `claude`, `codex`, and `opencode`. Per-harness status is listed in the [acceptance evidence](../README.md#compatibility-and-preview-limits). The CLI attempts to revoke the route when the child exits. If revocation fails, it warns; the route remains valid for up to 12 hours or until the daemon stops. The route token is neither printed nor stored in the runtime descriptor.

## Generated directory

```text
~/.config/traicer/
  traicer.config.json  non-secret runtime configuration and device public identity
  .env.schema          Varlock sensitivity and required-value declarations
  .env.local           external credentials and encrypted secret references
  .gitignore           local secret, Alchemy state, and dependency exclusions
  cache/decrypted/     bounded, compressed seven-day plaintext inspection cache
  infra/               optional Alchemy v2 storage stack
```

The daemon creates its SQLite state database in the selected configuration directory. Keep the entire directory private, back it up according to your seller recovery policy, and never commit it to a repository.
