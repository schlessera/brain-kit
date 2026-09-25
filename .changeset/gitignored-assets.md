---
"@schlessera/brain": minor
---

Images and PDFs that git ignores are no longer indexed. An ignored asset exists on one clone only, so indexing it there paid for a vision description and an embedding that no other clone would see, and made search results differ between clones. The asset scan now asks git once per run (`git ls-files --others --ignored --exclude-standard --directory`) and skips what it lists, and an asset that becomes ignored is removed on the next run, like a deleted file. Gitignored markdown is still indexed, so local-only notes stay searchable. Outside a git work tree, or without git, nothing is left out. `brain stats` `size.corpus` follows the same rule.
