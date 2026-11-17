---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": patch
---

Each review in a GitHub pull request read now says how many line comments it has (#4147), and the chat shows "Show n line comments" on that review. The SDK's review schema gains an optional `line_comments` (an exact count, or `null` for unknown; a result recorded earlier has none and reads as unknown), and `GITHUB_LIMITS.reviewComments` (100). The host counts from one bounded page of the pull request's review comments and gives every review `null` rather than a partial total when that page is cut short, a comment names no review, or GitHub's own total disagrees. In the chat, pressing a review's control loads only that review's comments through the detail route, following sparse pages a bounded number per press; a pull request whose reviews are not all counted, or not all in the result, still offers the other line comments in one section. Nothing loaded reaches the conversation.
