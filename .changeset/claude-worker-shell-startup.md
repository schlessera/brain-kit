---
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-ui-sdk": patch
---

Non-envelope Claude workers no longer import operator shell startup configuration (#2984). Their HOME is a fresh, empty, read-only mount, separate from the writable runtime-state tmpfs at CLAUDE_CONFIG_DIR. This covers successful shell snapshots and the CLI's login-shell fallback. Writes to `~/.npm`, `~/go`, `~/.cargo` and other HOME paths still fail with EROFS; they cannot consume transcript/credential storage or be misreported as runtime-state exhaustion. Credentials and config are resolved from the original environment before the HOME override and retain their existing preparation and persistence. The original host home stays read-only at its original path with the same profile masks; per-turn XDG storage and restricted-envelope behavior are unchanged.

Commands that found operator configuration through `~` must use an explicit path. Core's default `~/.local/bin` and geo's default cache/admission paths now resolve under the empty read-only HOME. Existing operator-home geo caches are no longer found implicitly; a geo cache miss refuses before any request, and no private per-worker admission state is created. Use the existing explicit configuration/environment facilities for other home-derived paths.

Non-envelope launches also discard BASH_ENV, ENV and ZDOTDIR startup redirects, including explicitly admitted values. Tools and variables previously supplied by a shell profile must come from the server's configured PATH and admitted environment. RTK continues to exclude the original host home when runtime HOME differs. The sandbox note describes Claude's empty read-only HOME, pi's original read-only HOME and the real host home's profile masks.
