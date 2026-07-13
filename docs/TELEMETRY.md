# Telemetry contract

Traicer sends only versioned, schema-validated control-plane records: device public identity, signed capture policy, storage/dry-run outcomes, safe manifests, aggregate inventory, immutable dataset roots, seller agreement signatures, and opaque buyer delivery envelopes.

Safe manifest fields are limited to provider/client/adapter identifiers, coarse capture time, model and usage counts, encrypted byte count, canonical/ciphertext hashes, redaction category counts, policy/pipeline versions, storage capability profile and integrity assurance, non-reversible bucket alias/object commitment, device/signer identifiers, and signature.

The marketplace client rejects generic metadata and common locator/secret field names before egress. Raw request/response bodies, prompts, code, filenames, repository names, local paths, bucket names, endpoints, object keys, presigned URLs, credentials, decryption keys, plaintext capabilities, headers, environment values, and free-form raw errors are prohibited.

Local status and diagnostics contain bounded operational counts and safe error codes. They never include trace bodies or secret/bootstrap material. Traicer has no third-party analytics SDK.
