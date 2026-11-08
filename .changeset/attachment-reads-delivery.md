---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": patch
---
Deliver recorded attachment reads to the browser so sent files can show what the agent read (#3589). A host with composer files advertises `server_hello.capabilities.attachmentReads`, answers `GET /api/sessions/:id/attachment-reads` with the recorded `read_attachment` calls of the originals a session's messages name (`{ fileId, turnId, outcome, scope, at }`, never text), and sends one `attachment_read` frame per read recorded during a live turn to connections that declared the flag. Nothing of either reaches a provider. The SDK adds `ATTACHMENT_READS_CAPABILITY`, `AttachmentReadEntry`, `SessionAttachmentReadsResponse`, `ServerAttachmentRead` and their schemas; the React client accepts the new frame without declaring the flag.
