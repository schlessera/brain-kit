---
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-server": minor
---

Mermaid diagram support across all render surfaces.

- ` ```mermaid ` (and ` ```mmd `) fences render as diagrams in chat messages,
  the markdown file previewer, `<share>` block previews, Write-tool previews,
  and the "What's up" briefing — one hook in `BrainMarkdown`, so every surface
  gets it.
- Streaming-safe: while a fence is still arriving the raw source shows as an
  ordinary code block; debounced parses (with a 400ms throttle floor) upgrade
  it to a diagram as soon as the source parses, and a failed parse keeps the
  last good SVG instead of flashing an error. Renders are cached, so per-token
  re-renders of a streaming message cost a lookup.
- Mermaid (~2MB) loads lazily on first diagram; `securityLevel: "strict"` and
  `suppressErrorRendering` are set.
- Share as PNG/PDF pre-renders fences to inline SVG on the client
  (`inlineMermaidDiagrams`, light "neutral" theme) before `POST /api/render`,
  since the render page runs without JavaScript or network. ui-server's share
  template gained matching `.mermaid-figure` styles.
- Standalone `.mmd` / `.mermaid` files get a diagram preview (with the usual
  preview/raw toggle) in the file viewer.
- `BrainMarkdown`'s component overrides are now identity-stable across
  renders, so streaming deltas no longer unmount/remount every code block.
