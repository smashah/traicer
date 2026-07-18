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
