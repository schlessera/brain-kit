---
"@schlessera/brain-ui-kit": patch
---

A not-posted GitHub draft now shows its whole body (#4197). `GitHubPullRequest` in `preview` cut a draft longer than 20,000 characters and said "Truncated · the rest is on GitHub", though a draft is not on GitHub yet and the host posts up to 65,536 characters. A draft keeps its 8-line clamp, whose expand control names the whole length. Read bodies keep their 20,000-character bound and their "Truncated" note. The W1 issue approval (`GitHubIssue` with `posting: { status: "preview" }`) already showed the whole body, and a unit test and a long-draft story now hold it to that.
