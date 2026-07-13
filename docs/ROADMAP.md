# Roadmap

1. **Milestone 0 — executable spike.** Finish the authenticated stdin bootstrap,
   Tauri sidecar supervision, SQLite integrity recovery, cross-target compiled
   daemon checks, and development signing evidence.
2. **Milestone 1 — private control plane.** Add vault integration, status,
   pause/resume, sanitised SSE, config migrations, diagnostics, restart budgets,
   autostart, and raw-canary scanning.
3. **Milestone 2 — explicit gateways.** Add the adapter SDK, Claude Code and one
   evidence-selected second adapter, exact upstream policies, streaming tee,
   redaction, deterministic canonical traces, encryption, and spool.
4. **Milestone 3 — sovereign storage.** Add capability-based S3 conformance,
   integrity receipts, manifest signing, privacy lint, Traice reconciliation,
   tombstones, and delivery-readiness probes.
5. **Milestones 4–5 — hardening and release.** Add the explicit proxy, external
   security review, signing/notarisation, updater, SBOM, provenance, uninstall,
   alpha rollout, and licence/third-party review.

Managed OS proxying and native transparent redirection are post-MVP and remain
opt-in, separately permissioned capabilities.
