---
"@schlessera/brain": minor
---

A brain written in another language can turn off English-only full-text processing. The new config key `search.language` sets the full-text tokenizer and the query's stopwords together. `"english"` (the default) keeps today's `porter unicode61` stemming and English stopwords. `"none"` uses `unicode61 remove_diacritics 2`, with no stemming and no stopwords. Changing it rebuilds the full-text index on the next `brain index`, which says so, and re-embeds nothing. The rebuild commits with the rest of that run or not at all, so a failed run leaves the old full-text index whole and the next one finishes the switch. The index records the tokenizer it was built with in `index_metadata` as `fts_tokenizer`. `brain doctor` has a new `search-language` check that reports the configured language and whether the index matches it.
