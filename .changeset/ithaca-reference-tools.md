---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

Agents on both backends can read shared reference source and use managed worktrees. Two new bridge tools, `reference_source` and `reference_worktree` (`request`, `access`, `renew`, `release`, `list`), share one strict contract in `@schlessera/brain-ui-sdk/tool-contracts` and stay in every interactive session's fixed roster; a turn without a host handler refuses the call. The host binds principal, turn and worker generation itself, and a result reports a path only where this turn's workers can reach it. Governed and strict turns now bind the public and principal's private source views read-only under `/tmp/brain-reference/`; before each bind, every source whose validation lapsed is validated again, and one that fails is withheld until a request validates it, and the app enables worktree generations whenever a reference pool exists. The native manager gains `poolView`, which opens a view's directory before its first publication.
