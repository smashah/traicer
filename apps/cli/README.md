# `@traice-market/traicer`

The seller-operated Traicer command line client. It scaffolds seller-owned S3-compatible storage through Alchemy v2, keeps runtime credentials behind Varlock, and starts the local capture daemon on loopback-only listeners.

```sh
bunx @traice-market/traicer init --storage cloudflare-r2 --account-id <account-id>
# add the marketplace and storage credentials to ~/.config/traicer/.env.local
bunx @traice-market/traicer secrets
bunx @traice-market/traicer start
```

`init` creates configuration only. It runs `alchemy deploy` solely when the user explicitly passes `--deploy` or confirms the interactive deployment prompt. External marketplace and storage credentials remain blank until the seller adds them to `.env.local`; `traicer secrets` invokes the packaged Varlock CLI to encrypt sensitive plaintext values in place.
