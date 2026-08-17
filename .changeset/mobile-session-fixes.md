---
"@schlessera/brain": patch
"@schlessera/brain-module-images": patch
"@schlessera/brain-ui-react": patch
"@schlessera/brain-ui-sdk": patch
---

Fix three things a real session on a phone turned up

- **Images written into the brain did not display in chat.** The markdown
  renderer overrode headings, code and links but not `img`, so
  `![](assets/images/x.png)` resolved against the app origin and 404'd — the
  bytes are served by the files API. Repo-relative sources are now rewritten to
  that endpoint; `data:` URIs and absolute URLs pass through untouched.
- **Scratch files had nowhere to go.** `brain render` and `brain image` refused
  any path outside the repo, which pushed intermediates — an HTML file that
  exists to be rendered two seconds later — into a knowledge base as git noise.
  Both now also accept paths under the system temp directory, report them
  absolute, and say that a file written there is not viewable in a UI. Anywhere
  else is still refused: this is scratch space, not free rein.
- **The generate-pdf skill refused documents over 400 KB**, citing a file-viewer
  download limit that does not exist. The real ceiling is the file server's
  (10 MB, both the preview and raw paths); below that, size is a judgement call
  about the reader's connection. The skill no longer refuses to produce a
  document for being over an invented figure.

Also corrects a comment on `FILE_SIZE_CAP_BYTES` claiming the `?raw=1` path was
unbounded. It is not — `resolveForRaw` enforces the same cap, which is why
raising it to 10 MB mattered for images and PDFs in the viewer too.
