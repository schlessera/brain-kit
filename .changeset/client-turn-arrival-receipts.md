---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Record client-monotonic turn frame-arrival timings once after host cleanup sends its final idle. Store the first owner-authorized report separately and join it onto lifecycle reads without modifying completed host records. Disconnects and lost reports leave only the measurement absent. Receipt transport has its own bounded routing and rate budget, malformed stored samples degrade only their own measurement, and existing Activity store implementers need not provide receipt support.

Capture composer Send before snapshot-save waits, retain early lifecycle arrivals, and meter before JSON decoding. Final host idle follows cleanup; it does not wait for a timing commit. Preserve unknown server timing fields and surface stored corruption even after embedded NUL bytes.

Keep lifecycle timing persistence off the turn's idle path. Only the client that actually dispatches a request may report its saved Send timing. Correlate queue-start announcements before backend identity, read lifecycle snapshots with their sequence consistently, and validate the original stored receipt byte length. Older Activity store implementations remain supported.

Determine receipt eligibility from in-memory cleanup state without lifecycle I/O on idle. Defer receipt storage behind the turn's persistence queue off the turn path so successful file-backed commits cannot lose their client report. Disqualify a shared request acknowledged before local dispatch, and enforce owner/duplicate and revocation checks while deferred.
