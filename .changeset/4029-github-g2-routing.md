---
"@schlessera/brain-ui-server": minor
---

The host GitHub read tools now follow the provider policy's data routing (#4029). GitHub is the provider-policy recipient `github`, beside `apify` and the web providers. `brain_github_issue_read` and `brain_github_issue_search` send a repository, a number or search text to GitHub, so a conversation that has shown a provider folder the policy does not let `github` receive is refused before any request, with `policy_denied` and reason `recipient_restricted`, and GitHub receives nothing. A conversation whose exposure cannot be judged under a policy that restricts `github` is refused the same way, with `recipient_unproven`. A conversation that showed no such folder reads as before.

If your policy has `providers` rules whose `allow` lists do not name `github`, GitHub reads start being refused in conversations that have shown those folders. That is the intended effect. Add `github` to a rule's `allow` list to let GitHub receive that rule's folders. The write tools are not routed: each write is still gated by its approval card, which shows exactly what is sent, and by `outward.github.repositories`.
