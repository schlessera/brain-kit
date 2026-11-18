---
"@schlessera/brain-module-images": minor
---

`brain image --format svg` has the GPT Image 2.6 models author a static SVG for a new image, written as a `.svg` file. SVG with `--ref`, `--mask` or `--transparent`, and SVG on a 2.5 or Gemini model, are refused before any request. A returned SVG that contains a script, an event handler, a `foreignObject`, an embedding element, a DOCTYPE, an `@import`, or a reference outside the document is refused and not written. An SVG's cost is reported as unknown.
