---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

**Agents can now read the PDFs and text files a conversation was sent (#3154).** A new `read_attachment` tool (`mcp__brain-ui__read_attachment` on Claude, `read_attachment` on pi) is in every interactive session's tools, with or without attachments. It reads one original a message of this conversation sent: PDF text by page, at most 20 pages per call, or a text file of any extension by byte range, at most 65,536 bytes per call and 262,144 per turn. A `next` cursor continues a cut-short result, in this turn or a later one. Each result says what it read: `read`, `partial`, `no_text` (a scanned page; no OCR is run), `encrypted` (no password is supplied), `malformed`, `failed`, `unavailable`, `changed` or `refused`. PDFs are parsed by pdf.js in a short-lived child process with a 30-second, 20-CPU-second and 1 GiB limit, two at a time per host. Contents are never injected when a file is sent: the first message carries references only, and new messages' `<brain-attachments>` block names the tool.

`@schlessera/brain-ui-server` now depends on `pdfjs-dist` (Apache-2.0, `^6.3.289`, the range `@schlessera/brain-ui-react` and `@schlessera/brain-render-puppeteer` already use), and adds migration 078 (`attachment_reads`). The SDK adds the tool contract, `AttachmentReadResult`, `handleReadAttachment`, `formatAttachmentRead` and `BackendBridge.readAttachment`.
