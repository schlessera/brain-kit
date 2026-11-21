---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-sdk": minor
---

A module cron job can now call the GitHub API of the repositories it was granted (#4259) without holding a token. A job whose module's `repositories` and the host's `BRAIN_UI_MODULE_REPOSITORIES` grant a `github.com` repository gets a per-run relay socket, named in `BRAIN_MODULE_GITHUB_SOCKET`. The relay forwards REST `GET` reads and repository GraphQL queries with the host's new `BRAIN_UI_MODULE_GITHUB_TOKEN`, which has no fallback. It forwards writes (`issue_comment`, `issue_state`) only where the operator enables them per repository in `BRAIN_UI_MODULE_GITHUB_WRITES`. Everything else is refused before a request leaves the host. Each write is recorded on the job's Activity run.
