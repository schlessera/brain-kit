---
"@schlessera/brain-ui-react": minor
---

Recording timestamps now measure complete emitted WebM/Opus audio rather than elapsed delivery time. This changes the meaning of exported LocalCaptureChunk and Recording duration fields; existing stored timestamps remain readable. The ten-minute audio cap and 100-MiB budget remain. A separate eleven-minute monotonic backstop retains interrupted audio. Unsupported formats, including audio/mp4, retain conservative wall-time accounting.
