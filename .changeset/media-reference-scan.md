---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
---

Media findings now record which notes reference them (#2781). One bounded scan of the brain's `*.md` notes, outside hidden directories and `context/hygiene/`, finds the declared reference forms: Markdown inline links and images (including `<…>` destinations), reference definitions, and wiki links and embeds, which a later Move can rewrite; and frontmatter values and HTML `src`, `href` and `poster`, which are only detected. Code blocks and inline code are never references.

The `refs` field of every media fingerprint, which recorded `unscanned`, is now `none`, a digest of each reference's note, form and destination as written (line numbers left out, so an unrelated edit reopens nothing), or `too-large`/`unscannable` when the scan was refused. **This reopens every media disposition (dismissed, snoozed or kept) once**, which is the safe direction: no decision stays bound to a reference set nobody checked. Adding or removing a reference to a dismissed file reopens it from then on. `brain sync`'s count and hygiene review compute it the same way.

The scan is bounded by `BRAIN_MEDIA_REFERENCE_LIMITS`, a trusted host setting of `<limit>=<n>` pairs over the defaults `notes=50000`, `noteBytes=268435456`, `perNote=4194304`, `scanTime=20000` (ms) and `refsPerFinding=500`. Each limit is checked before the work it bounds; past one, the whole scan is refused and never reports "no references". An invalid value stops `brain hygiene`'s media detection rather than being guessed. The server passes the variable through to the brain CLI.
