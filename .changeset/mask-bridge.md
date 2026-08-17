---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-backend-claude": minor
---

Add a mask bridge: the reader paints the region an image edit applies to

Masked inpainting needs someone to point at part of a picture, and there is no
server-side substitute for that. This mirrors the existing location bridge: the
agent calls `mcp__brain-ui__request_image_mask`, the browser opens a canvas over
the image, and the painted PNG comes back over the socket.

- **ui-sdk** — `mask_request` / `mask_response` / `mask_error` frames, validated
  at the boundary with the same decoded-byte budget as a chat image, plus
  `BackendBridge.requestMask`.
- **ui-server** — pending-mask state on the turn coordinator, the bridge method,
  and inbound routing. Cancels reject the promise like every other pending
  interactive request, so a disconnect mid-paint fails the tool instead of
  hanging the turn.
- **ui-react** — a `MaskEditor` modal: paint with a sized brush, undo, clear.
  Strokes are drawn on a capped working canvas and rescaled to the source
  image's true pixel dimensions on export, so a mask drawn on a phone lines up
  with a 4K original. Painted pixels export as fully transparent, which is the
  convention the edit endpoint reads.
- **ui-backend-claude** — the tool, auto-allowed like the other bridge tools
  (the editor itself is the approval), and a system-prompt line telling the
  agent to ask rather than guess coordinates.

The mask is written next to its image and the path returned, because what
consumes it is `brain image --mask <path>`.
