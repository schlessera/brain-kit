---
"@schlessera/brain-ui-sdk": patch
---

A refused worker launch can no longer start its payload (#3387). bubblewrap starts a sandbox on its start gate's end-of-file as it does on a go byte, and a refused launch used to close that gate right after signalling bubblewrap, so a sandbox process still alive could run the unqualified payload. A refused gate now stays open until bubblewrap and every process it gated are confirmed dead: the launcher stops bubblewrap, kills its children and the verified sandbox process, and only then closes the gate. A gate whose processes never die stays open.
