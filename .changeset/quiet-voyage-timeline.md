---
"@schlessera/brain-ui-react": patch
---

Place background task answers where their words arrive in the live discussion, retaining stable display positions across streamed updates and reconnects. Window generated speech together with backend messages and distinguish restored speech whose original position is unknown.

Preserve recovered replay prefixes and complete Markdown/link/classified-block semantics across interleaved chunks. Declare the existing Markdown decoder directly for exact escaped-text source ranges.

Copy and export complete original answers, including earlier arrivals and classified or tool-backed blocks, independently of transcript display filtering.

Preserve latest-turn Retry actions and source ordered-list numbering across arrival ranges.
