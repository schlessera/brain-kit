---
"@schlessera/brain": minor
---

One list of tool leftovers now drives three places. It covers OS metadata (`.DS_Store`, `Thumbs.db`, `Desktop.ini`, `*:Zone.Identifier`), editor swap and backup files (`*.swp`, `*.swo`, `*~`) and LaTeX byproducts (`*.aux`, `*.out`, `*.toc`, `*.synctex.gz`, `*.fls`, `*.fdb_latexmk`):

- `brain sync assess` classifies them as `ARTIFACT`. Before, `*:Zone.Identifier` and the LaTeX files came back `UNKNOWN`.
- A new `brain doctor` check, `tracked-leftovers`, warns about any that are already committed and shows the `git rm --cached` command to untrack them. It never runs the command.
- The brain template's `.gitignore` ignores all of them.
