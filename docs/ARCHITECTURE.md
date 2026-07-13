# Architecture

The Tauri shell owns the tray, single-instance lifecycle, OS keychain access,
updates, and Bun sidecar supervision. The React webview invokes narrow Tauri
commands and never receives the daemon token, vault key, storage credentials, or
provider secrets.

The Bun sidecar owns three separately authorised surfaces: a random-port Hono
control API, a stable-port fixed-upstream provider gateway, and a later explicit
forward proxy. Every listener binds loopback only. The current spike implements
the authenticated control surface; provider forwarding is deliberately absent.

```text
coding client -> local fixed-upstream gateway -> provider
                         |
                         v
 policy -> redaction -> canonical hash -> local encryption
                         |                    |
                         |                    v
                         |             seller-owned storage
                         v
               signed safe manifest -> Traice Market API
```

Only the final signed safe-manifest branch may contact Traice. Raw content and
reusable storage access remain outside that network path by construction.
