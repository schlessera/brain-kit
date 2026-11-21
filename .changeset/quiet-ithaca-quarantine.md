---
"@schlessera/brain-ui-server": minor
---
Scrub up to 64 journal-store directory entries per idle maintenance pass, quarantining verified orphan files while retaining their quota charge and reporting counts, skips and integrity failures in maintenance Activity.

Retry quota-refused scrub candidates individually, preserve unexpected object types, and contain pending-file recovery sync failures per reservation. Optional capacityBlocked metadata reports deferred quarantine charges without changing existing reason values.

Bound directory enumeration to 4 KiB per pass on the qualified Linux runtime, contain individual read errors in optional readFailures diagnostics, include quota-refused orphan bytes in the report, and retry interrupted producer recovery during idle maintenance.

Admit the optional quarantine schema on first scrub rather than allocating it during upgrade. Near-cap journals keep ordinary writes usable and report an optional schemaSkipReason until the schema fits.
