---
"@schlessera/brain": minor
---

`exclude.dirs` entries are normalised when the config loads. A leading `./` and trailing `/` are stripped, so `drafts/`, `./drafts` and `drafts` all exclude the same directory.

**Effect on an existing brain:** a bare `drafts` always worked. `drafts/` and `./drafts` excluded nothing from the index. If your config uses one of them, the files under that directory leave the index on your next `brain index`, and stop appearing in search, context and briefings. `brain stats`'s `size.corpus` changes with them: it already left out a `drafts/` entry's files, but it counted a `./drafts` entry's files, and it now leaves both out, in agreement with the index. An entry that is empty once stripped (`./`, `/`) is ignored.
