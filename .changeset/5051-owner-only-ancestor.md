---
"@schlessera/brain-ui-sdk": patch
---

Launch qualification no longer refuses state that a separate worker identity cannot reach: a private-state root below a host directory that is owned by none of the sandbox's UIDs and has no group or other permission bit is reported as ownership-only and released, as an owner-only root itself already was (#5051). A separate-UID host whose server state directory is owner-only, with database files the default umask left group- or world-readable, no longer has every unmasked maintenance launch refused.
