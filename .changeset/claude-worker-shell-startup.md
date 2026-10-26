---
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-ui-sdk": patch
---

Non-envelope Claude workers no longer import operator shell startup configuration (#2984). Their HOME is a fresh, empty, read-only mount, separate from the writable runtime-state tmpfs at CLAUDE_CONFIG_DIR. This covers successful shell snapshots and the CLI's login-shell fallback. Writes to `~/.npm`, `~/go`, `~/.cargo` and other HOME paths still fail with EROFS; they cannot consume transcript/credential storage or be misreported as runtime-state exhaustion. Credentials and config are resolved from the original environment before the HOME override and retain their existing preparation and persistence. The original host home stays read-only at its original path with the same profile masks; per-turn XDG storage and restricted-envelope behavior are unchanged.

Rc-file masking was measured first with the real CLI. It preserves implicit Git config reads for fixed existing files, but a read-only bind remains a live view: a previously absent profile created by the host after enumeration leaks into both the snapshot and login fallback. Binding over the absent path up front fails with EROFS, and a startup symlink can redirect the mask onto another config file. The maintainer's empty-HOME fallback is therefore retained. Image-owned system startup files remain out of scope.

Commands that found operator configuration through `~`, including `~/.gitconfig`, `~/.npmrc` and `~/.netrc`, must use an explicit path where the profile exposes it. Core's default `~/.local/bin` and geo's default cache/admission paths now resolve under the empty read-only HOME. Existing operator-home geo caches are no longer found implicitly; a geo cache miss refuses before any request, and no private per-worker admission state is created. Use the existing explicit configuration/environment facilities for other home-derived paths.

Non-envelope launches also discard BASH_ENV, ENV, ZDOTDIR, SHELLOPTS, BASHOPTS and exported BASH_FUNC_*%% functions, including explicitly admitted values. Tools and variables previously supplied by a shell profile must come from the server's configured PATH and admitted environment. RTK continues to exclude the original host home when runtime HOME differs. The sandbox note describes Claude's empty read-only HOME, pi's original read-only HOME and the real host home's profile masks.
