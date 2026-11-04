---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
---

The media lists in `brain.config` can now be changed one entry at a time (#2781). `brain config media <add-track|remove-track|add-ignore|remove-ignore> <pattern> --dry-run --json` previews the change: the diff, the files sync sees now that the pattern matches (count, bytes, the five largest, which an ignore entry still wins over, which are secret-shaped), and an approval digest. Applying it with `--expect-sha <sha256>` from that preview, and optionally `--expect-approval <digest>`, splices only that entry into a literal config, without running it, and refuses `stale` or `stale-approval` with nothing written when the config or its matches changed.

Persist here can track a file by a broader rule. `brain hygiene media persist <id> --pattern <glob>` (and `keep-copy … --pattern`) adds that `media.track` rule instead of the exact path, and `--ignore-adjust <entry>` removes the one broader `media.ignore` entry that would still win. The preview adds `scope`, `pattern`, `ignoreAdjust`, `matches` and `approvalDigest`; apply needs `--expect-approval` back. Exact changes are unchanged and need no approval. Several conflicting ignore entries are still refused, now each named.

Hygiene review offers *Persist with a broader rule…* on a media card that is not in scratch or staged by a share, previewed with the rule as its input. A copy destination under one broader ignore is previewed with that ignore removed and the files it stops ignoring. Only the principal who previewed a broader change can confirm it; anyone else gets `stale-approval`.

The UI SDK adds `HygieneMediaMatches` and `hygieneMediaMatchesSchema`, the optional `scope`, `pattern`, `ignoreAdjust`, `matches` and `approvalDigest` on `HygieneMediaPlan`, and `approvedBy` on `HygieneEffect`.
