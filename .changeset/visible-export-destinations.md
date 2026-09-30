---
"@schlessera/brain-render-template": minor
"@schlessera/brain-render-puppeteer": minor
"@schlessera/brain-ui-server": patch
"@schlessera/brain-ui-kit": patch
---

Add an opt-in visible-destination policy for PNG/PDF exports and enable it
server-side for all app render requests. Accepted links keep canonical
navigation with a validated visible host or mail address; refused links and
unavailable repo paths stay inert. Raw/full/bare HTML, SVG targets, shadow
content and embedded documents cannot bypass it. Chrome checks final disclosure,
and the renderer lazily loads PDF.js to check each finished PDF annotation's own
complete destination and print legibility,
and refuses an export that still conceals or crops a destination. CLI defaults,
classification rules and render isolation stay unchanged. UI-kit link imports
re-export the same pure classifier from the template's dependency-safe leaf.
