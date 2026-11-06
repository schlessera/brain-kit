---
"@schlessera/brain-ui-react": minor
---

**Generic composer files (#3155, first slice).** When the host advertises `capabilities.composerFiles`, the composer offers an unrestricted **Files** source with no format allowlist. Desktop shows one Files… action and paste-or-drop guidance, without Photo library or Camera. Phones keep Photo library and Camera beside Files. Picked, pasted and dropped files that are not images upload unfiltered to `POST /api/drafts/:draftId/files`, and the host decides what each one is. Images keep their existing processing.

- **Chips say what is known.** A chip shows waiting, uploading, waiting for connection, `checking upload…` (no answer yet), upload failed, or the host's refusal (too large, no space). A stored PDF or text file reads `not read yet`. A file without a reader reads `no reader here` and can still be sent. A rejected track reads `not a usable track`.
- **Lost answers.** A lost answer is uploaded again with the same idempotency key, once automatically on reconnect or with **Upload again**. It never stores a second copy and is never reported as not stored.
- **Saving and sending.** A stored original becomes part of the draft. It is saved as a `fileIds` binding and reads as saved only once the host acknowledges that revision. Send holds while uploads or that save are pending, then sends `attachmentRefs` with the acknowledged `draftRef`.
- **Sent messages.** A sent message lists its originals by name, kind and size, with no claim about which contents were read.
- **Older hosts.** A host without `composerFiles` keeps the previous menu and the tab-only track queue.
- **API.** `ChatMessage.attachmentFiles?` is additive.
