# ADR 0002: OpenTelemetry GenAI is the canonical trace shape

Status: accepted.

## Decision

Traicer canonicalises, hashes, encrypts, and stores one OTel GenAI-shaped record identified by
`traice.otel-genai.trace/1`. The previous `traice.trace/*` records are deleted rather than decoded,
translated, negotiated, or emitted alongside the new record. There is no production inventory or
buyer contract to migrate, so a compatibility layer would create two sources of truth without
protecting a real user.

The target is the standalone OpenTelemetry GenAI semantic-conventions registry's development schema
identifier `https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev`, pinned to commit
`b694ec35855d8eccfacd5b09e4b72a808b363038` on 2026-08-05. That registry depends on core semantic
conventions 1.44.0, has no release or tag at the pin, and remains Development. Its schema identifier
was not a published HTTP resource at the pin, so every canonical record and safe manifest carries
both the identifier and commit rather than implying a stable release.

## Canonical record

The top-level record carries the Traicer schema identifier, OTel GenAI schema identifier, pinned
commit, one `CLIENT` inference span, and a `traice` namespace for local-capture facts. Standard span
attributes are the source of truth:

- `gen_ai.provider.name`, `gen_ai.operation.name`, `gen_ai.request.model`, and
  `gen_ai.response.model` identify the operation and keep requested and actual models distinct.
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, and the optional cache-creation,
  cache-read, and reasoning-token attributes preserve provider-reported usage without inventing a
  total-token attribute.
- `gen_ai.system_instructions`, `gen_ai.input.messages`, and `gen_ai.output.messages` use the OTel
  ordered role/parts structures. Model-visible tool requests and results use `tool_call` and
  `tool_call_response` parts.
- `gen_ai.tool.definitions` carries ordered available tools; `gen_ai.response.finish_reasons` and each
  output message's `finish_reason` describe why generation stopped.
- `openai.api.type` distinguishes Responses from Chat Completions where it applies.

The `traice` object contains `traceId`, capture time, client, adapter, pipeline version, redaction
report, redacted provider request/response serialization, HTTP response status, optional opaque
capture-run/project-scope IDs, and provenance `provider_exchange`. Those values have no generic OTel
home, so none are published under invented `gen_ai.*` keys.

Marketplace task outcome, task, and domain labels also have no natural OTel GenAI attribute.
`gen_ai.response.status` and finish reasons describe generation mechanics, while
`gen_ai.evaluation.*` applies only when a named evaluator actually ran. Marketplace work must keep
those labels under a Traicer-owned namespace unless a later OTel convention defines their meaning.

## Deterministic serialization profile

OTel defines field meanings and structured JSON shapes, not canonical bytes. Traicer therefore uses
these additional rules before hashing and encryption:

1. Object keys are sorted recursively with JavaScript's default UTF-16 code-unit ordering. Array
   order is preserved for messages, content parts, output choices, finish reasons, and tools.
2. Unavailable optional fields are omitted. Explicit JSON `null` remains distinct from absence, and
   `undefined`, functions, symbols, cycles, and non-finite numbers are rejected.
3. Finite numbers use ECMAScript `JSON.stringify`'s shortest round-trippable representation, which
   also emits negative zero as `0`; token counts are non-negative integers.
4. Structured tool arguments and results are parsed from provider JSON strings when valid, then the
   structured value is canonicalised. An invalid JSON string remains a string.
5. Mandatory transport-secret stripping and body redaction happen before mapping, canonicalisation,
   hashing, encryption, storage, or manifest construction. The canonical bytes are the bytes passed
   to the existing local AES-GCM envelope and seller-owned object store.

The determinism acceptance test canonicalises identical input twice and canonicalises again after a
JSON serialize/deserialize round trip; all three byte strings must match exactly.

## Version markers and marketplace contract

This replacement moves the canonical identifier to `traice.otel-genai.trace/1`, the pipeline marker
to `otel-genai/1`, and the manifest marker to `traice.manifest/3`.

The complete manifest-facing field list for the marketplace lane is:

- `schema`, `canonicalTraceSchema`, `otelSchemaUrl`, `otelSemconvCommit`, `pipelineVersion`, and
  `provenance`;
- `clientManifestId`, `canonicalHash`, `ciphertextHash`, `capturedAt`, optional `projectScopeId`,
  `provider`, `model`, `client`, `adapter`, `inputTokens`, `outputTokens`, and `toolCallCount`;
- `capturePolicyId`, `policyVersion`, and `redaction` containing detector version, profile, and
  replacement category counts;
- `encryptedBytes`, `storageKind`, `storageCapabilityProfileId`, `storageIntegrityAssurance`,
  `bucketAlias`, and `objectLocatorCommitment`;
- `deviceId`, `signerKeyId`, `verificationTier`, plus the detached signature in the enclosing signed
  manifest.

The manifest remains content-free: it contains no messages, prompts, tool arguments/results, raw
provider bodies, headers, storage locations, credentials, or reusable capabilities.

## OTLP ingest

OTLP ingest is deferred. The daemon has fixed-provider gateway inputs but no OTLP receiver,
protobuf/JSON decoder, span grouping policy, or authenticated listener contract. Adding only a route
would leave message normalization, JSON-string structured-attribute convergence, provenance, and
multi-span handling incomplete. A later OTLP change must enter before redaction, converge structured
attributes onto these canonical bytes, preserve the loopback/authentication boundary, and use a
provenance class distinct from `provider_exchange` because Traicer did not observe the provider
exchange itself.

## Consequences

Buyers can consume the standard GenAI attribute and message vocabulary without a Traicer-specific
trace translation. The Development convention can still change, so a future adoption requires a new
Traicer canonical schema and pipeline marker rather than silently changing the bytes behind version
1. Owner reads accept only the replacement schema; objects produced by the removed prototype schema
are intentionally unsupported.
