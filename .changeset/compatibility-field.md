---
"@schlessera/brain": minor
---

Declare skill dependencies in `compatibility:`, and fix a macOS break

The Agent Skills specification allows exactly six frontmatter keys, and
claude.ai upload, the Skills API and the reference validator reject a skill
carrying anything else. Ten shipped skills carried `requires:`, a brain-kit
invention — so they could not be published through any of those surfaces.

`compatibility` is the specification's slot for exactly that statement, and it
reads better: prose an author can act on ("Requires git and an authenticated
gh") rather than a bare token list. The linter now reads it, matching whole
words so `github` does not satisfy a `git` dependency and `docker.io` does not
satisfy `docker`. `requires:` keeps working — it is still honoured for the
shell-command check — but now warns and names its replacement.

Two skills still carry `disable-model-invocation:`, which no specification field
replaces. It stays: dropping it would make `sync` — which pushes to a remote —
model-invocable again, and that safety property is worth more than validator
cleanliness.

Separately, `content-hygiene` no longer depends on GNU coreutils. Its stable
issue IDs came from `sha1sum`, which macOS does not ship, so the one skill
designed to run unattended on a schedule failed silently there. The pipeline is
now `{ sha1sum 2>/dev/null || shasum; }`; both print the digest first, so IDs
match whichever exists.
