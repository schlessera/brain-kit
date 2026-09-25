---
"@schlessera/brain-ui-sdk": patch
---

A key-value run's values now read the way the same text reads in a quote, a table or a list. Before, they kept their markdown source: `**Crew:** **600**` gave the value `**600**`, `12 &amp; more` stayed encoded and `\*600\*` kept its backslashes. The keys are still read from the source. An escaped or entity-encoded `mailto:` still stays in the value, and now reads as `mailto:` rather than as `mailto&#58;`.
