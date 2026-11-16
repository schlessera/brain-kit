---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-react": patch
---

Hosted chat turns can read GitHub issues and pull requests through two new host tools, `brain_github_issue_read` and `brain_github_issue_search` (#3797). They are in every interactive session's fixed roster on Claude (`mcp__brain-ui__*`) and pi, and in no autonomous roster. The host calls the GitHub API with a dedicated token, `BRAIN_UI_GITHUB_TOOLS_TOKEN`, and never falls back to `GITHUB_TOKEN`: without it the tools answer `unavailable`, and no worker or maintenance environment ever receives it. Results are typed payloads (issue, pull request with reviews, checks, size and commits, or a bounded search with its total and a github.com search link), with text GitHub users wrote marked untrusted and every direct link checked by the new `githubDirectUrl` and `githubSearchUrl` validators or left `null`. A read taints the session with the new governance source `github_result`, shown as "GitHub result". The SDK also declares the two write tools, `brain_github_issue_create` and `brain_github_issue_comment`, whose approval cards arrive separately.
