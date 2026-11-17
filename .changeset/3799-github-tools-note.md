---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-ui-server": patch
---

#3799: the outward note in both backends' fixed system prompt now names the host GitHub tools by the backend's visible names. It says the worker holds no GitHub credential, so `gh`, `curl` and WebFetch cannot act as the user on GitHub. When the tools are absent, or answer `unavailable` or `policy_denied`, the model is to tell the user what they said and stop rather than fall back. A raw shell connection to GitHub's API still waits on its `Network` approval card. The `BRAIN_UI_GITHUB_TOOLS_TOKEN` reference now covers the write tools and the fine-grained permissions they need. The hosting guide gains a section on setting up the GitHub tools.
