---
"@schlessera/brain-ui-server": patch
---

Keep ordinary maintenance working after a strict worker publishes private output. With a separate worker identity, Git input preparation used to refuse once a published `0700` directory existed, so the authenticated index returned HTTP 500. The worker collector now withholds directories its identity cannot search. The server then reads only the nested `.gitattributes` of withheld directories it owns, from the retained checkpoint. Modes and ownership stay unchanged, and aliases, foreign owners and replaced identities still refuse.
