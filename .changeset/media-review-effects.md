---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Media findings can now be acted on from hygiene review (#2781): Delete, Move to a final location, Persist here, and Keep a permanent copy of a conversation-linked scratch file.

`brain hygiene media <delete|move|persist|keep-copy> <id> --expect-fingerprint <fp> [--to <path>] --dry-run` plans an effect and writes nothing: every file it would write with its expected SHA-256 before and after, the note references a Move rewrites (each in its own style; code untouched), the frontmatter and HTML references that block a Move, the `media.track` change, the bytes Undo must retain, and named refusals such as `pinned-scratch`, `exists`, `name-collision`, `not-final-location`, `not-expressible` or `config-not-literal`. Applying with `--expect-premise <digest> --journal <id>` recomputes the plan and writes only if nothing changed; it never overwrites a file and never compensates by itself. `persist` and `keep-copy` add the exact `media.track` entry to a literal `brain.config`, parsed as syntax only. `BRAIN_MEDIA_REFERENCE_LIMITS` gains `rewrittenNotes` (200) and `preview` (1 MiB).

The UI server captures every pre-image in the bounded change journal before the CLI writes, and refuses as `capture-capacity` when it cannot. A failed or interrupted effect is put back file by file, only where a file still holds what the effect wrote; anything edited since is left alone and reported, so the outcome is honestly `partial`. Undo checks the retained data and every file first, and refuses without writing when either changed. A restart compensates an interrupted effect and never re-applies it. Keep a permanent copy records its `kept` entry only after the copy is verified, and removes the copy if that record is refused; the original's bytes, path and pins are never touched.

The UI SDK adds the `media-delete`, `media-move`, `media-persist` and `media-keep-copy` effect operations, `InboxOption.media` (the plan), the `kept` outcome status and `HygieneAction.outcome.media` (the receipt). A server and CLI ship together: an older server reading a `kept` result fails closed as `check_failed`.
