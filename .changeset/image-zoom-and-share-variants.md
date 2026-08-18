---
"@schlessera/brain-ui-react": minor
---

Zoom images the way diagrams zoom, and stop treating quality as a problem

An inline image is only as wide as the viewport, so a generated one was visible
but not legible — the same complaint mermaid diagrams had before they got a
viewer. Images now get that viewer, and the pan/zoom surface behind it is shared
rather than copied.

- **`ZoomViewer`** (`components/viewer/`) is the extracted stage: pointer pan,
  pinch and wheel zoom, fit/zoom/close toolbar, Escape, body-scroll lock,
  re-fit-while-untouched. `MermaidViewer` is now a thin wrapper over it and
  behaves exactly as before (diagrams still fit up to 250%; images cap fit at
  100%, since past that a raster shows only interpolation).
- **Tapping an image opens it** — in chat markdown, in the file viewer's binary
  preview, and on a user message's attachment thumbnails (those are
  object-cover crops, so the full frame was not even visible before).
- **Sharing an image is now two explicit actions.** "Share original" ships the
  bytes untouched; "Share optimized" re-encodes toward 2048px / 1 MiB for
  messaging, and falls back to the original when the image is already inside
  that target rather than recompressing for show. Nothing is downgraded
  silently, and the file on disk is never touched.
- The `generate-pdf` skill's size guidance already said the 10 MB server cap is
  the only real ceiling; this makes the UI live up to it, because a
  full-resolution image is what makes zooming worth anything.
