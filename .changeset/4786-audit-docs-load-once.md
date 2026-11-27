---
"@schlessera/brain": patch
---

`brain hygiene`, `brain audit` and `brain briefing` load the indexed corpus once per command instead of three or four times (#4786). The audit and the diagrams check share the rows the caller loaded, a hygiene detection plans the index registry once and hands its rows to the reconcile and the repair path, and `brain briefing` hands its rows to the audit it counts. The repeated-text check keys its candidates by a hash of each paragraph instead of holding a second copy of the corpus text. The diagrams check still reads every note from disk. Findings, their order and fingerprints, and the briefing text are unchanged.
