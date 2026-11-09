---
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-kit": minor
---

The composer's draft status is now a compact indicator beside Attach, replacing the line under the field (#3155). It shows success only once the host acknowledges this exact text with every attached file. Otherwise it shows that the draft is saving, waiting for an upload, offline, unconfirmed, failed or refused. Its tooltip and details carry the facts, with Compare drafts, Open other version, Open Storage, or Check again, which reads the draft once and never saves it. After a reload, a file that was still uploading is named in a dismissible notice instead of coming back as a chip. `BrainUiConnection.drafts` gains `checkSave(draftId)`.

The kit `Composer` gains an optional `status` slot beside the attach trigger. It is a 44px box that keeps the field's height.
