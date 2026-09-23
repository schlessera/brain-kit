---
"@schlessera/brain": minor
---

`exclude.dirs` entries are normalised when the config loads. A leading `./` and trailing `/` are stripped, so `drafts/`, `./drafts` and `drafts` all exclude the same directory.

**Effect on an existing brain:** those spellings used to exclude nothing. If your config uses one, the files under that directory leave the index on your next `brain index`. They stop appearing in search, context and briefings. `brain stats`'s `size.corpus` already left them out, and now agrees with the index. An entry that is empty once stripped (`./`, `/`) is ignored.
