---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": minor
---

Replace new turns' per-file history of covered writable Git checkouts with one code-changes receipt; ignored files and intermediate versions are no longer retained. Retain legacy history and note before-images, and add endpoint preview and owner-confirmed checkout revert. Checkout capture currently has a 16 MiB content ceiling.
