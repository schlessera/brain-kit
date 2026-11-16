---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": patch
---

The chat's GitHub components can load what a GitHub tool result left out without putting it in the model's context (#3796). Two internal routes serve it to the chat's owner account only, for an issue or pull request a GitHub tool result in that session returned: `GET /api/sessions/:id/github/:owner/:repo/:number/:part` pages its `comments`, `reviews`, `review-comments`, `commits`, `files` or `checks`, at most 30 items a page with a cursor, under the dedicated `BRAIN_UI_GITHUB_TOOLS_TOKEN`; and `GET /api/sessions/:id/github/avatars/:login` serves the avatar of a user in those results from the brain's own origin, fetched without credentials, accepted only as PNG, JPEG, GIF or WebP by its bytes within a byte and pixel cap, and kept in a bounded in-memory cache. Every direct link passes `githubDirectUrl` or is `null`. Failures are typed, and a spent rate limit names its reset time. Nothing either route serves is added to the conversation, journaled as turn input or recorded as taint. The SDK adds the page, item and error schemas; ui-react adds the internal `fetchGithubDetailPage` and `githubAvatarUrl` helpers.
