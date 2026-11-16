---
"@schlessera/brain-common": minor
"@schlessera/brain": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

Hosted chat turns can file GitHub issues and comment on them through the two host write tools, `brain_github_issue_create` and `brain_github_issue_comment` (#3798). Both backends now list them in every interactive session's fixed roster, after the read tools, and in no autonomous roster. A write goes only to a repository the governance policy lists under the new key `outward.github.repositories`, as `owner/repo` or `owner/*` (compared without case); any other repository is refused before an approval card is shown, and an absent or empty list allows no writes. A malformed entry makes the policy invalid. Inside the list, the user approves each write on one card showing exactly what will be sent, and it is sent once; a denial, an edited approval or a voice turn sends nothing. Every decision is recorded as an outward action and listed as irreversible in the turn journal. `brain policy check --json` reports the new key under `effective.outward.github.repositories`.
