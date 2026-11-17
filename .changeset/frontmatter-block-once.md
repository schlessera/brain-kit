---
"@schlessera/brain-common": patch
"@schlessera/brain": patch
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-react": patch
---

Where a document's frontmatter block starts and ends now has one implementation, `frontmatterBlock` in the new internal entry `@schlessera/brain-common/internal/frontmatter-block` (#2507). It follows the rule `parseFrontmatter` reads by. `frontmatterLength` moved there too, and core re-exports it. Five fixes follow. `brain validate` accepts a document whose frontmatter follows a byte order mark, and reports a `----` first line as missing frontmatter. `brain import --stamp` skips a file whose frontmatter follows a byte order mark instead of stamping a second block over it. The OKF bundle check sees frontmatter after a byte order mark. `brain hygiene` reads and keeps such a log file's frontmatter instead of rewriting it as body. `brain tags --apply` and the frontmatter key editor share one bounds and scalar reader. One rule is stricter than before: hygiene now refuses a log file whose closing fence has text after the dashes (`----`, `---x`). The public `splitFrontmatter` from `@schlessera/brain-ui-react` now reads a block that follows a byte order mark, has trailing whitespace after its opening fence, or is closed by a fence at the end of the file. It still returns an unclosed block as body. `bun run lint` refuses a frontmatter fence detected by hand in package source. The new entry, and its re-export from the ui-sdk's `internal/client`, are internal and carry no compatibility promise.
