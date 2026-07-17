# Client configuration

Traicer captures only traffic that a seller deliberately routes through a loopback endpoint. It does not scan processes, inject into coding tools, change the system proxy, or capture arbitrary network traffic.

## Fixed provider gateway

The fixed gateway is the preferred connection mode. It accepts configured Anthropic and OpenAI routes, requires a short-lived capability embedded in the URL, and forwards only supported provider paths.

1. Start Traicer and copy the **Gateway** URL shown by the desktop app.
2. Set that value as the provider base URL in the coding client.
3. Keep the normal Anthropic or OpenAI API key configured in the client. Traicer forwards safe authentication headers to the original provider and does not act as the provider account.
4. Send a successful request to a supported path, then check **Local trace lifecycle** in Traicer.

For Claude Code, the provider base URL is normally supplied with `ANTHROPIC_BASE_URL`:

```sh
ANTHROPIC_BASE_URL='<gateway-url-shown-by-traicer>' claude
```

Keep the URL out of shared shell profiles and committed `.env` files because it includes the local adapter capability.

OpenAI-compatible clients use different setting names. Configure the full displayed gateway URL as the client's OpenAI base URL and keep its API key setting pointed at the real provider credential. Do not append `/v1` unless the client specifically requires it; the Traicer gateway URL already includes its routing prefix and capability.

## Explicit HTTP/HTTPS proxy

The desktop app can also show an authenticated URL shaped like:

```text
http://traicer:<local-capability>@127.0.0.1:<random-port>
```

Use it as `HTTPS_PROXY` or the client's explicit proxy setting only when the client supports proxy credentials. For exact supported provider hosts, Traicer can terminate TLS after the seller explicitly trusts the generated current-user CA. Other public hosts are blind-tunnelled; private, loopback, `.local`, mixed-address, and unsafe targets are denied.

```sh
HTTPS_PROXY='<proxy-url-shown-by-traicer>' your-client-command
```

Some clients pin provider certificates, ignore proxy environment variables, or strip proxy credentials. In those cases, use the fixed gateway. Traicer does not attempt to bypass certificate pinning.

## Capture policy

| Provider | Captured | Forwarded without capture |
| --- | --- | --- |
| Anthropic | `POST /v1/messages` | token counting and model lookup |
| OpenAI | `POST /v1/responses`, `POST /v1/chat/completions` | embeddings and model lookup |

Only successful provider responses become capture candidates. Unsupported fixed-gateway routes are rejected. In explicit-proxy mode, allowed provider requests enter the gateway while other provider routes are forwarded without becoming traces.

## Pause and failure behaviour

Pausing Traicer stops new capture persistence but keeps the local process under seller control. If provider forwarding succeeds and a later local capture stage fails, Traicer does not deliberately replace the provider response with a capture error. The failed exchange produces no seller object and no marketable manifest.

If the coding client cannot reach its provider, switch it back to the original provider base URL first. That isolates provider access from Traicer routing while you work through [Troubleshooting](TROUBLESHOOTING.md).

## CLI routing

The CLI keeps capability-bearing URLs out of its output. Link the current repository with `traicer project link`, keep `traicer start` running, and generate a preview launch with `traicer run -- claude`, `traicer run -- codex`, or `traicer run -- opencode`. Claude Code 2.1.212 on macOS has been manually acceptance-tested; Codex and OpenCode currently have unit and synthetic evidence. The CLI attempts to revoke the route when the client exits; a failed revocation produces a warning, and the route expires within 12 hours or when the daemon stops.
