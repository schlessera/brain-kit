---
"@schlessera/brain-backend-pi": patch
---

A pi worker now sends its transcript whole once per turn and then only the entries it appended, and the host appends those lines to the saved session file instead of validating and rewriting the whole transcript about three times per tool step. A step with no new entry writes nothing. The saved bytes are unchanged: the file still equals one line per entry, as a whole rewrite writes it. The append refuses a symlinked or hard-linked file before writing, rewrites the whole file when its size is not what the host saved, and truncates a failed append back. The 16 MiB bound still applies to the size the whole transcript would have as one frame.
