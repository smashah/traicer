# Traicer agent rules

Traicer is a seller-operated local capture service. Raw trace bodies, plaintext
delivery data, reusable object-store credentials, provider keys, control tokens,
vault keys, and private signing material must never enter logs, manifests,
telemetry, issue fixtures, or marketplace requests.

- Use pnpm only for dependency management; Bun is the runtime, test runner, and
  standalone sidecar compiler. Do not add `bun.lock` or run `bun install`.
- Bind local listeners to loopback only. The control API uses a random port and
  a constant-time bearer-token comparison.
- Capture is deny-by-default and fail-open for provider forwarding but
  fail-closed for persistence.
- Mandatory secret stripping precedes parsing, redaction, canonicalisation,
  encryption, storage, and manifest construction.
- Import across packages through package exports and `workspace:*`; never use
  relative imports that escape a package.
- `repos/effect`, if added, is read-only reference material. Imports from
  `repos/` are forbidden.
- Do not claim a milestone, adapter, platform, storage provider, signature, or
  installer works without the corresponding acceptance evidence.

## Docs sync with traice.market

- The user-facing docs in this repository (`README.md`, `docs/`,
  `apps/cli/README.md`) are the canonical source. The traice-market repository
  renders its own hand-written version of them for sellers at
  `traice.market/docs` (`apps/website/content/docs/traicer/`); that copy is a
  different voice for a different audience, never a verbatim mirror.
- A push to `main` touching any canonical docs path triggers
  `.github/workflows/docs-sync-notify.yml`, which files or appends to a
  `traicer-docs-sync` issue in smashah/traice-market carrying the commit
  summaries, a compare link, and the sync contract. Write docs commit messages
  as qualitative change summaries — they become that issue's body.
- The site records its last sync in
  `apps/website/content/docs/traicer/.sync.json` (`traicerCommit`,
  `traicerVersion`, `syncedAt`) in the traice-market repository. When working
  in traice-market on site docs, treat an open `traicer-docs-sync` issue or a
  stale `.sync.json` as a blocker for publishing docs claims.
- The workflow authenticates with the `TRAICE_MARKET_TOKEN` repository secret,
  a fine-grained PAT scoped to smashah/traice-market with Issues read/write
  only.
