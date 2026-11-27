---
"@schlessera/brain-ui-sdk": patch
---

Internal: the union inside `dialogueEvidenceSchema` is now compared with `DialogueEvidence` in both directions at compile time (#4896). The schema keeps its published `ZodType<DialogueEvidence>` cast, which hid that union from the schema parity check, so a key added to or dropped from one of its members compiled. What the schema accepts and every published signature are unchanged.
