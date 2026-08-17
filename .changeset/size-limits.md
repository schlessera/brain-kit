---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

Raise the preview, upload and share size limits to match the frame budget

The socket already accepts ~12MB inbound (brain-ui sets `maxPayloadLength` to
`MAX_CLIENT_FRAME_BYTES + 64KB`), but the limits layered above it were never
lifted to use that headroom. Worst case today was 6MB decoded — about 8MB once
base64 inflates it — against a 12MB frame.

- `MAX_IMAGE_BYTES` 2MB → 4MB. This mostly governs GIFs: everything else is
  downscaled to 1568px and re-encoded to JPEG client-side, landing far below
  either number, while a GIF passes through untouched so its animation
  survives.
- `MAX_TOTAL_IMAGE_BYTES` 6MB → 8MB, which is ~10.7MB base64 and still leaves
  the JSON envelope room inside the 12MB frame.
- `FILE_SIZE_CAP_BYTES` 5MB → 10MB for the JSON preview path. Raw bytes
  (`?raw=1`) stream from disk and were never bounded by it, so this only ever
  affected text previews.
- Render/share content 512KB → 4MB. That bound predated inlined assets: a
  shared document carries `data:` image URIs and pre-rendered mermaid SVGs,
  which pass 512KB without the prose being long. It is an HTTP body, not a
  socket frame.

Left alone: `MAX_WS_MESSAGE_BYTES` (512KB, server → client). That one bounds
what the browser renders and what reverse proxies will pass, which is a
different risk than what the user can send.
