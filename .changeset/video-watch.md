---
"@schlessera/brain": minor
"@schlessera/brain-module-video": minor
---

Add an opt-in Gemini video module with timestamped watch answers, clip windows,
privacy disclosure and bounded upload/use/delete cleanup. Extend completion
parts with video, optional video capability and request cancellation; existing
custom providers without video capability remain valid and refuse video.

Raise the optional Gemini SDK minimum to 2.24.0 so every supported installation
has the client-level fetch option needed to cancel binary uploads.
