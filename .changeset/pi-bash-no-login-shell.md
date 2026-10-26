---
"@schlessera/brain-backend-pi": patch
---

The pi backend's `bash` tool no longer runs commands in a login shell (#2960). It used `bash -lc`, so `/etc/profile` and the first of `~/.bash_profile`, `~/.bash_login` or `~/.profile` under the `HOME` the command received ran before every command. Their output reached the model in the tool result, and every variable or `PATH` entry they exported overrode the allowlisted environment, including tokens the allowlist withholds on purpose. Commands now run through `bash --noprofile --norc -c`, and `BASH_ENV` and `ENV` are removed from the command's environment even when admitted through `BRAIN_UI_SUBPROCESS_ENV_EXTRA`, so neither the command nor a shell it starts reads a startup file.

A command's `PATH` and variables are now exactly the filtered environment. If a host relied on a login profile to put a tool on `PATH`, put that directory on the server's own `PATH`; set a variable a profile used to export in the server's environment and admit it with `BRAIN_UI_SUBPROCESS_ENV_EXTRA`.
