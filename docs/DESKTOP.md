# Desktop app

The Traicer desktop preview wraps the local Bun daemon in a Tauri shell. It owns native lifecycle, the tray, OS credential storage, current-user proxy CA trust, launch-at-login, and signed application updates.

## Download the correct package

Use the [latest GitHub release](https://github.com/smashah/traicer/releases/latest):

| Platform | Package |
| --- | --- |
| Apple Silicon macOS | `aarch64-apple-darwin` DMG |
| Intel macOS | `x86_64-apple-darwin` DMG |
| Windows | Setup EXE for a normal install; MSI for managed installation |
| Debian or Ubuntu x64 | DEB package |

The `.app.tar.gz` files and `latest.json` are updater payloads, not first-install packages. `.sig` files are signature sidecars, checksum files verify downloads, and SBOM files describe bundled dependencies. GitHub also adds source ZIP and tar archives automatically; neither is a desktop installer.

The current installers are previews. macOS and Windows may show OS trust warnings because production code signing is not configured, and macOS packages are not notarised. Verify the checksum before opening a package.

## First run

The setup form requires:

- **Provider:** Anthropic Messages or OpenAI-compatible capture.
- **Client label:** A local label such as `claude-code`, `codex`, or `opencode`.
- **Marketplace API and credential:** The Traice Market API URL and a device-scoped seller credential.
- **S3 endpoint, bucket, prefix, and region:** The dedicated seller-owned storage destination.
- **Storage access key and secret:** Credentials scoped to the required bucket operations.

Selecting **Authorise device and start** registers the device and signed capture policy with Traice Market, stores secrets in the operating-system credential vault, runs the storage and privacy checks, and starts the sidecar. The React webview receives only safe configuration and status.

## Connect a coding client

After startup, the **Live state** card shows:

- A fixed gateway URL for the selected provider. Use this as the provider base URL in a supported client.
- An authenticated explicit-proxy URL. Use this only with a client that honours proxy configuration and after understanding the local CA flow.

The URLs contain a local capability. Treat them like credentials: do not paste them into issues, screenshots, shared shell history, or committed configuration. See [Client configuration](CLIENT_CONFIGURATION.md) for routing options.

## Local proxy CA

Traicer can generate a private local CA and leaf certificates for the exact supported provider hosts. **Trust local proxy CA** adds that CA to the current user's trust store; it does not install a system-wide transparent redirector or silently change system proxy settings.

Remove CA trust from Traicer before uninstalling if you enabled it. The daemon must be stopped before removal. Clients with certificate pinning or incompatible TLS behaviour may reject interception; use the fixed gateway instead.

## Controls and seller work

The desktop app can:

- Start, pause, resume, and stop capture.
- Enable launch at login.
- Show safe local trace summaries and request permanent deletion with a signed marketplace tombstone.
- Fetch marketplace requests, commit an eligible local dataset, propose the exact signed agreement root, and prepare buyer-encrypted delivery after acceptance.
- Check and install Tauri-signed updates for supported platforms.

Deleting a trace removes seller-storage ciphertext, submits a signed tombstone, and then erases the local object reference. A seller action that commits or delivers a dataset is separate from passive capture and requires an explicit click.

## Local data and diagnostics

Configuration and secrets live in the operating-system credential vault. Operational state, encrypted-spool metadata, manifest outbox state, and safe trace lifecycle data live in the daemon's local SQLite database.

Diagnostics contain bounded status, counters, and version identifiers. They exclude trace bodies, credentials, object locators, local paths, and raw errors. Even so, review diagnostic output before sharing it and use private security reporting for suspected vulnerabilities.
