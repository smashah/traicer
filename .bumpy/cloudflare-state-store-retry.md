---
"@traice-market/traicer": patch
"@traice/desktop": patch
---

Retry Cloudflare storage deployment while a newly bootstrapped Alchemy state store finishes propagating, preventing transient first-run 500 responses from aborting `traicer init`.
