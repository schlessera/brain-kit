---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-ui-server": patch
---

#3799: both backends' fixed system brief (the append a new interactive session retains) now names the host GitHub tools by the backend's visible names. It says the worker holds no GitHub credential, so `gh`, `curl` and WebFetch cannot act as the user on GitHub. When the tools answer `unavailable` or `policy_denied`, the model is to tell the user what they said and stop rather than fall back. A session retained earlier keeps its append byte for byte. A raw shell connection to GitHub's API still waits on its `Network` approval card. The `BRAIN_UI_GITHUB_TOOLS_TOKEN` reference now covers the write tools and the fine-grained permissions they need. The hosting guide gains a section on setting up the GitHub tools.
