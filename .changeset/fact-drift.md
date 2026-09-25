---
"@schlessera/brain": minor
---

`brain audit` catches a restated fact that drifted from its canonical value. The config key `taxonomy.facts` names, for each fact, the document that holds the value in a `facts:` frontmatter map (`facts: { ranger_since: 2019 }`), and the case-insensitive patterns, each with one capture group, that find the fact restated in prose. Every other non-archived markdown document that states another value gets a `fact-drift` warning, `"<key>: found <x>, canonical <y>"`, once per fact. Numbers compare as numbers, and text inside code is skipped. A document can list the keys it restates on purpose as they once were under `facts_ignore:`. A pattern without exactly one capture group fails config load. The content-hygiene skill now takes these issues from `brain audit --json` and keeps its own judgment pass only for canonical files without a `facts:` map.
