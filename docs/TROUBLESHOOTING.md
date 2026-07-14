# Troubleshooting

Start by separating provider access from capture. Point the coding client back at the original provider URL; if the provider still fails, fix that account or network issue before debugging Traicer.

## The installer is blocked by the operating system

The current macOS and Windows packages are previews without production OS code signatures, and macOS packages are not notarised. Confirm that the file came from the [official GitHub release](https://github.com/smashah/traicer/releases/latest), verify its SHA-256 checksum, and follow your organisation's policy for unsigned software. Do not disable OS security controls globally.

## Device registration is unavailable or rejected

Check the marketplace API URL, seller account state, and device-scoped credential. The desktop app must register the device and activate its signed capture policy before saving the configuration. A generic web session cookie or buyer credential is not a replacement for the seller device credential.

## Seller storage conformance failed

Verify the endpoint, bucket, region, addressing style, and credential scope. Traicer must write, HEAD, fully read, presign, and delete a synthetic object; large-object operation also requires multipart permissions.

Common causes are a wrong signing region, credentials scoped to a different bucket, missing `GetObject` or multipart actions, an endpoint that returns different metadata through HEAD, and an S3-compatible service without complete SigV4 support.

## Capture safety dry run failed

Traicer will not enable persistence when its synthetic secret-stripping, redaction, canonicalisation, encryption, or manifest check fails. Restart once after confirming that the installed version and local state are intact. If the same error returns, report the version and sanitised error code privately; do not include the synthetic payload output or any real trace.

## The client reaches Traicer but a route returns 404

The fixed gateway accepts only the current provider's supported paths plus a small forward-only set for model lookup, token counting, or embeddings. Confirm that the client is using the provider selected during Traicer setup and that it has not appended a second `/v1` to the displayed gateway URL.

## Provider requests work but no trace appears

Check that capture is not paused, the request used a supported capture path, and the provider response was successful. Forward-only routes and failed provider responses do not become traces.

Trace persistence runs after the provider response is copied. A local failure can leave the provider request successful while producing no object or manifest; inspect the bounded Traicer status rather than retrying with sensitive prompts.

## The explicit proxy returns 407

The client did not send the capability-bearing proxy credentials. Use the complete proxy URL shown by the desktop app and confirm that the client honours authenticated proxy URLs. Keep that URL out of committed configuration and public support output.

## TLS interception fails for Anthropic or OpenAI

Confirm that **Trust local proxy CA** is enabled for the current user and restart the client so it reloads the trust store. If the client pins certificates or uses an incompatible TLS path, remove proxy CA trust after stopping Traicer and switch to the fixed gateway.

Traicer does not bypass certificate pinning. Non-target hosts should remain blind-tunnelled, while private, loopback, `.local`, and mixed public/private DNS targets are denied by the proxy.

## The daemon restart budget is exhausted

The desktop shell allows at most three starts within five minutes to avoid a crash loop. Wait five minutes before retrying. Repeated crashes after that window should be reported with the app version, platform, and sanitised bounded diagnostics.

## The CLI reports a missing Varlock value

Open the selected configuration directory and confirm that all required external fields in `.env.local` are filled, then run `traicer secrets --directory <path>` again. Do not replace generated `varlock(...)` references or paste their decrypted values into the shell.

## Safe support information

You may share the Traicer version, operating-system version, capture status, safe error code, and a synthetic reproduction. Never share raw prompts, responses, source code, provider headers, credentials, private keys, adapter or control capabilities, bucket names, endpoints, object keys, presigned URLs, local paths, or unredacted logs.

Use [public issues](https://github.com/smashah/traicer/issues) for non-sensitive defects and [GitHub private security advisories](https://github.com/smashah/traicer/security/advisories/new) for suspected vulnerabilities.
