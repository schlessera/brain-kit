---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Add the shared read-only bubblewrap worker launcher and refuse interactive,
voice, autonomous and handoff-summary turns before runtime initialization when
the actual host boundary probe fails. Native macOS and Windows hosts refuse.
Expose the SDK's environment descriptors at the root export; the worker payload
is internal transport, required only by the trusted bootstrap.
