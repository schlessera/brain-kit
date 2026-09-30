---
"@schlessera/brain-ui-react": patch
---

`useDictation` releases capture through one helper shared by Stop/Cancel and its unmount cleanup. No behaviour change: teardown still invalidates the in-flight start, aborts a pending session request and stops the current ASR client, including one started after the hook mounted.
