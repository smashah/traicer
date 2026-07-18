# Changelog










## 0.3.2
<sub>2026-07-18</sub>

- [#28](https://github.com/smashah/traicer/pull/28) [`824d96b`](https://github.com/smashah/traicer/commit/824d96b2a4eb0f5e4aaf4fec7f86c0717ed995f5)  *(patch)*
  Linked the duplicated acceptance-evidence claims in the CLI readme and user guides to the canonical compatibility table so tested client and provider combinations are documented in one place, and added a repository layout section to the documentation index.

## 0.3.1
<sub>2026-07-17</sub>

- [#25](https://github.com/smashah/traicer/pull/25) [`2c956ae`](https://github.com/smashah/traicer/commit/2c956aefa5f56edd16a6e7e74f069fdd2d112bad)  *(patch)* - Allow cached owner trace reads without requiring object-store credentials

## 0.3.0
<sub>2026-07-17</sub>

- [#22](https://github.com/smashah/traicer/pull/22) [`a8e3df2`](https://github.com/smashah/traicer/commit/a8e3df2e05e6edbff81088aae3367bc35d3f636b)  *(minor)* - Add local-first owner trace access, Traices Explorer, and service lifecycle commands

## 0.2.5
<sub>2026-07-17</sub>

- [`c00b1c4`](https://github.com/smashah/traicer/commit/c00b1c428f6c996d615ffde5c596205de85de70d)  *(patch)*
  Made Cloudflare R2 initialization deterministic with Alchemy beta.63, added a safe `traicer reset` command, fixed daemon restarts after SQLite migrations, and allowed encrypted capture to continue with manifests pending when no Traice Market account is configured.

## 0.2.4
<sub>2026-07-17</sub>

- [`8213bd0`](https://github.com/smashah/traicer/commit/8213bd081a6beee607a2d1955a6bc7d38ebbe09a)  *(patch)*
  Retry Cloudflare storage deployment while a newly bootstrapped Alchemy state store finishes propagating, preventing transient first-run 500 responses from aborting `traicer init`.

## 0.2.3
<sub>2026-07-17</sub>

- [`609c814`](https://github.com/smashah/traicer/commit/609c814b405cefa14dac552c326edb030910a403)  *(patch)*
  Made `traicer init` resumable after a managed storage deployment fails, while preserving existing configuration and encrypted device secrets.

## 0.2.2
<sub>2026-07-17</sub>

- [`b539612`](https://github.com/smashah/traicer/commit/b539612ba58f8ce167459d5833d836e54708e9a6)  *(patch)*
  Fixed generated Alchemy storage projects failing to start with Effect beta.98 by pinning the compatible Alchemy beta.62 release.

## 0.2.1
<sub>2026-07-16</sub>

- [`af29c13`](https://github.com/smashah/traicer/commit/af29c13bfb6654f5734b4f810b70f27f42da2c45)  *(patch)*
  Fixed Cloudflare account discovery when an older Wrangler installation shadows an authenticated JSON-capable Wrangler later on PATH.

## 0.2.0
<sub>2026-07-16</sub>

- [`86cdf06`](https://github.com/smashah/traicer/commit/86cdf06aa6f093ca8332dedeb66cb7ff61663164)  *(minor)*
  Added privacy-preserving project scopes and supervised Claude Code, Codex, and OpenCode launch settings over shared seller storage.

## 0.1.0
<sub>2026-07-14</sub>

- [`a3d5cb2`](https://github.com/smashah/traicer/commit/a3d5cb2caa77bf22f5509a9c8095e33a59a35df3)  *(minor)*
  Ship the seller-operated Traicer CLI with guided Varlock secret setup and optional Alchemy v2 provisioning for Cloudflare R2, AWS S3, or an existing S3-compatible service. Capture now accepts only successful provider responses and removes stale upstream compression metadata after Bun decodes response bodies.
