# Threat model

The main protected assets are raw provider traffic, seller code and prompts,
provider credentials, storage credentials, encryption and signing keys, control
capabilities, local configuration, and the accuracy of marketplace-safe
commitments.

The first release assumes one local desktop user and treats browser origins,
LAN peers, arbitrary client input, provider responses, object-store responses,
marketplace responses, configuration files, and diagnostics requests as
untrusted. Local malware with the user's full privileges and a compromised OS
are not covered by the version-one security guarantees.

Required controls include loopback-only listeners, random scoped capabilities,
constant-time token comparison, fixed upstreams, exact method/path allowlists,
bounded parsing, mandatory secret stripping, typed redaction state transitions,
authenticated encryption, encrypted spool limits, content-free telemetry,
signed atomic updates, reversible client configuration, and seller approval
before any delivery capability is created.

Security claims remain unverified until the corresponding fixture, packet
capture, clean-machine, crash-recovery, and external-review gates pass.
