---
"@schlessera/brain-ui-react": minor
---

Hygiene review in Actions now decides media files (#2782). A media card shows the file with a small preview, its size, type and probed dimensions, which notes use it and which conversations link it, and offers Persist here, Persist with a broader rule…, Move to a final location…, Keep a permanent copy… and Delete…. A choice that isn't available stays listed with its reason. Choosing one starts a preview of exactly what will change: rewritten links, the config entry, the two copies a kept copy leaves, or a broader rule's current matches, which need your approval. Only the latest preview can be applied, and `a` applies only a current one. Leave pending (`l`) skips the file for this pass and still counts it. After a change, the receipt stays above the next file with Undo…. Stale, refused, busy, partial and interrupted outcomes are each stated, with focus on the control that recovers.

Images load when the card is shown. A scratch video or audio file, and a file over the size limit, wait for Load preview. A file too large for the files route shows no preview at all. The pass summary reads `Media awaiting review: N · M set aside · K kept as a copy`.

`createBrainApi`'s `hygienePreview(request, signal?)` now resolves to `HygienePreviewResponse`, and the new `hygieneMediaUndo(journalId)` undoes a confirmed media effect. In the inbox store, a `deferred` or `kept` outcome now settles a decision as success instead of as not applied.
