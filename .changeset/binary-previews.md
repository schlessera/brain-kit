---
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-server": minor
---

The file viewer previews PDFs, audio and video inline instead of offering only a download. A PDF is drawn by pdf.js, one page per canvas down the panel, and tapping a page opens it in the zoom viewer. MP3 and WAV play in a native `<audio>` element, and MP4 and WebM in an inline `<video>`. A file the browser cannot open after all falls back to the "Preview not available" card, which any other binary still gets. The binary viewer picks its previewer from a table keyed by MIME type.

New config field `pdfWorkerUrl`: the URL of pdf.js's worker script, `pdfjs-dist/legacy/build/pdf.worker.min.mjs`, imported by the shell (with Vite, `?url`). Without it, or when it does not start a worker of the bundled pdf.js version, PDFs are parsed on the main thread. `@schlessera/brain-ui-react` now depends on `pdfjs-dist`.

The raw file route (`/api/files/content?raw=1`) answers a single byte range with `206 Partial Content`, and a range past the end with `416`. Every raw response carries `Accept-Ranges: bytes`. iOS Safari plays video and audio only from a server that does this.
