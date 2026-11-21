---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Record client-monotonic turn frame-arrival timings once after the host has committed completion and sent its final idle. Store the first owner-authorized report separately and join it onto lifecycle reads without modifying completed host records. Disconnects and lost reports leave only the measurement absent. Receipt transport has its own bounded routing and rate budget, malformed stored samples degrade only their own measurement, and existing Activity store implementers need not provide receipt support.

Capture composer Send before snapshot-save waits, retain early lifecycle arrivals, meter before JSON decoding, and mark final idle complete only after reading the terminal commit. Preserve unknown server timing fields and surface stored corruption even after embedded NUL bytes.
