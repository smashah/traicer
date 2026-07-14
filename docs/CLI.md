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
--storage <provider>      cloudflare-r2, aws-s3, or existing-s3
--provider <provider>    anthropic or openai
--account-id <id>        Cloudflare account ID; required for cloudflare-r2
--bucket <name>          Existing bucket name; required for existing-s3
--endpoint <url>         HTTPS S3-compatible endpoint; required for existing-s3
--region <region>        Signing region; R2 uses auto, other modes default to us-east-1
--marketplace-url <url>  Traice Market API base URL; defaults to https://api.traice.market
--directory <path>       Configuration directory
--deploy                 Install generated infra dependencies and run Alchemy deploy
--yes                    Accept safe defaults without granting deployment permission
```

When interactive input is available, omitted values are prompted. With `--yes`, required values without safe defaults remain empty and validation fails rather than inventing credentials or account identifiers.

### Cloudflare R2

```sh
traicer init \
  --storage cloudflare-r2 \
  --account-id <cloudflare-account-id> \
  --provider anthropic
```

The Cloudflare account ID is public account metadata, not an API token. `init` generates an Alchemy v2 R2 stack under `infra/`; add `--deploy` only when you intend to create the bucket in that account.

### AWS S3

```sh
traicer init \
  --storage aws-s3 \
  --region eu-west-2 \
  --provider openai
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
TRAICER_MARKETPLACE_CREDENTIAL
TRAICER_STORAGE_ACCESS_KEY_ID
TRAICER_STORAGE_SECRET_ACCESS_KEY
TRAICER_STORAGE_SESSION_TOKEN      optional
```

The initializer already writes encrypted Varlock references for the adapter capability, control token, device signing key, and local envelope-wrapping key. Do not replace those references with plaintext.

## `traicer start`

```sh
traicer start [--directory <path>]
```

`start` resolves Varlock values, sends the bootstrap to the daemon once over stdin, and removes `TRAICER_*` values from the daemon process environment. The daemon binds its control and provider gateway listeners to `127.0.0.1` on random ports.

On success it prints a JSON record similar to:

```json
{"controlPort":49152,"gatewayPort":49153,"proxyPort":null,"pid":12345,"protocolVersion":1,"type":"ready"}
```

The control API requires a separate bearer capability and is not a public integration surface. Do not expose either loopback listener through a tunnel, container port mapping, LAN bind, or reverse proxy.

### Endpoint limitation

The fixed gateway URL contains the provider name and generated adapter capability as well as the random port. This release does not provide a supported `traicer endpoint` command, so the CLI alone does not offer the desktop app's safe copy-and-paste routing flow.

Treat this as an operator limitation, not an invitation to print or commit the adapter capability. Use the desktop app for routine client routing until a dedicated endpoint command can expose it deliberately.

## Generated directory

```text
~/.config/traicer/
  traicer.config.json  non-secret runtime configuration and device public identity
  .env.schema          Varlock sensitivity and required-value declarations
  .env.local           external credentials and encrypted secret references
  .gitignore           local secret, Alchemy state, and dependency exclusions
  infra/               optional Alchemy v2 storage stack
```

The daemon creates its SQLite state database in the selected configuration directory. Keep the entire directory private, back it up according to your seller recovery policy, and never commit it to a repository.
