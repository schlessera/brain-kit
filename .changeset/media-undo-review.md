---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

A confirmed media effect can now be undone from hygiene review (#2781). `POST /api/hygiene/review` accepts `{ "operation": "undo-media", "journalId" }`, the journal ID on the resolved card's media receipt. It runs the same checks as Undo elsewhere, so it refuses without writing anything when the saved bytes were evicted or a file changed since. The response carries the Undo's receipt as `mediaUndo`. The card keeps its resolved status and gets the Undo's receipt. The review's `fixed` or `kept` counter drops, and the finding is pending again, on a new card.

Undoing Keep a permanent copy now also removes its `kept` entry, after the copy and config are restored, so the original is pending again instead of reopening as `copy-missing`. The new `brain hygiene unkeep <id> --journal <id>` removes exactly the kept entry that journal recorded, or refuses `not-kept` and writes nothing.

The UI SDK adds `HygieneReviewMediaUndoCommand` and `HygieneReviewRequest` (either command), with `hygieneReviewMediaUndoCommandSchema` and `hygieneReviewRequestSchema`; `HygieneReviewCommand` and its schema are unchanged. `HygieneReviewRead` gains the optional `mediaUndo` receipt.
