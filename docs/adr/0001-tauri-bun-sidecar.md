# ADR 0001: Tauri shell supervises a Bun sidecar

Status: accepted for the executable spike.

The Tauri process owns native lifecycle, keychain, updater, and OS integration;
the Bun process owns capture, policy, persistence, storage, and marketplace-safe
egress. Secrets pass from the desktop shell to the daemon once through stdin and
are never placed in arguments, environment variables, files, or stdout. This
separation keeps the webview and native updater out of the raw capture pipeline
while allowing the TypeScript daemon to be tested and compiled independently.
