# Storage

Traicer writes encrypted trace envelopes directly to a bucket controlled by the seller. Use a dedicated bucket and credentials scoped to that bucket; do not reuse an administrator key or a credential shared with unrelated applications.

Storage initialization is AI-provider agnostic. The same bucket configuration backs both Anthropic and OpenAI capture adapters, so `traicer init` does not take an AI-provider flag.

## Required behaviour

An S3-compatible service must support:

- Object put, head, get, and delete operations.
- Multipart create, part upload, completion, and abort for large encrypted objects.
- SigV4 request signing and presigned GET URLs.
- Custom object metadata returned consistently by HEAD and GET.
- Full object readback so Traicer can verify the ciphertext hash after upload.
- HTTPS outside loopback development.

Traicer runs a synthetic write/head/read/presign/delete conformance probe before enabling capture. A service that accepts a write but cannot return matching metadata and bytes does not pass.

## Minimum credential scope

Map these operations to the equivalent policy actions for your provider:

```text
PutObject
GetObject
HeadObject
DeleteObject
CreateMultipartUpload
UploadPart
CompleteMultipartUpload
AbortMultipartUpload
```

The AWS SDK may express HEAD through the same `s3:GetObject` permission used for GET. Restrict access to the dedicated bucket and Traicer prefix, and allow no public bucket policy. Traicer does not need bucket listing for its normal object lifecycle.

## Cloudflare R2

```sh
traicer init \
  --storage cloudflare-r2
```

Traicer tries `wrangler whoami --json` to read public account metadata from an installed, authenticated Wrangler CLI, then asks which account ID to use. Pass `--account-id <cloudflare-account-id>` to bypass discovery. The selected ID is written into the S3 endpoint and generated Alchemy stack, and it is passed as `CLOUDFLARE_ACCOUNT_ID` for an immediate deployment.

Alchemy performs its own authentication and deployment. Traicer does not copy Wrangler's OAuth token or turn the account selection into R2 API credentials.

This writes an Alchemy v2 R2 stack under `~/.config/traicer/infra`. It does not deploy until you pass `--deploy` or confirm the interactive prompt.

After the bucket exists, create an R2 S3 API token scoped to that bucket and place its access key ID and secret in `.env.local`. The endpoint is derived as:

```text
https://<cloudflare-account-id>.r2.cloudflarestorage.com
```

R2 uses signing region `auto` and path-style addressing.

## AWS S3

```sh
traicer init \
  --storage aws-s3 \
  --region eu-west-2
```

The generated Alchemy stack declares a private, versioned bucket with AES-256 server-side encryption and public-access blocking. Traicer also encrypts every accepted trace locally before upload; bucket-side encryption is an additional storage control, not a substitute for the local envelope.

Use the real bucket region for SigV4 signing. The CLI derives the standard regional AWS endpoint and uses virtual-hosted addressing.

## Existing S3-compatible service

```sh
traicer init \
  --storage existing-s3 \
  --endpoint https://s3.example.com \
  --bucket traicer-data \
  --region us-east-1
```

Traicer uses path-style addressing for this mode. Confirm the service's region string, metadata behaviour, multipart support, and presigned URL compatibility before using it with real work.

## Credentials and rotation

The CLI stores external credentials in `.env.local` and resolves them through Varlock. The desktop app stores them in the operating-system credential vault. Neither credential belongs in a marketplace payload, diagnostic export, issue, screenshot, or committed config file.

To rotate storage credentials, pause or stop capture, update the secret through the same configuration surface, then start Traicer and let the conformance probe run again. Keep old credentials active only long enough to avoid interrupting pending multipart or deletion work.

## Seller data lifecycle

Traicer stores canonical trace ciphertext under the configured prefix. Large uploads use a durable local multipart journal so completed parts can resume after interruption. Temporary delivery objects use separate short-lived records and are deleted by the local cleanup loop after expiry.

A local deletion request removes the seller object, submits a signed marketplace tombstone, and erases the local object reference only after the earlier steps complete. Bucket lifecycle rules should complement this flow rather than deleting active objects before Traicer can reconcile them.
