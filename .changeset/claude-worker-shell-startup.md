---
"@schlessera/brain-backend-claude": patch
---

Claude workers no longer import the operator's shell startup configuration (#2984). The CLI's HOME now names its private runtime-state tmpfs, which contains no operator rc/profile files, including when the CLI falls back to a login shell after snapshot creation fails. Credentials and config are resolved from the original host environment before that override and keep their existing preparation and persistence. The original host home remains read-only at its original path with the same profile masks, and per-turn XDG directories keep their bounded temporary storage.

Non-envelope Claude launches also discard `BASH_ENV`, `ENV` and `ZDOTDIR` startup redirects, even when explicitly admitted through the subprocess environment extras. If a command relied on a shell profile for tools or variables, configure the server's PATH and admitted environment explicitly. Commands that found other operator configuration through `~` must name its path explicitly.
