---
"@schlessera/brain": patch
---

`brain list --help` now names `--include-archived`, `brain module --help` names the settings verb's `--stdin` and `--action`, and `brain queue --help` and `brain schedule --help` say that `--root` is accepted and ignored (#4929). Help text only: no flag changes what it does, and no `--json` shape changes.
