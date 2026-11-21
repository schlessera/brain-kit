---
"@schlessera/brain-ui-sdk": minor
---

No subprocess or worker receives the host's Google credential (#4206). `BRAIN_UI_GOOGLE_HOME`, `BRAIN_UI_GOOGLE_KEYRING_PASSWORD` and `BRAIN_GOOGLE_LEDGER` join the host-only secrets, and every `GOG_*`, `BRAIN_UI_GOOGLE_*` and `BRAIN_GOOGLE_*` name is host-only too: `filterSubprocessEnv` admits none of them for any audience, `BRAIN_UI_SUBPROCESS_ENV_EXTRA` and a spawn's own additions cannot name them, and the worker launcher and maintenance launches drop them, transports included, whatever their caller passed. The launchers now drop every other host-only secret from transports as well. A `GOG_*` variable set on the host therefore never reaches a worker, where gog would read a home, keyring, account or access token from it.
