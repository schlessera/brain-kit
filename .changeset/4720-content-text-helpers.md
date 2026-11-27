---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

`@schlessera/brain-ui-sdk/server` exports the experimental backend toolkit helpers `textParts(content)` and `textOfParts(content, separator)` (#4720), and both backends read the text parts of a content array through them instead of a dozen inline joins. A Claude tool result made of several text blocks now replays in session history with the newlines it showed live, instead of as one run-together string. Every other site keeps its separator, so prompt matching and provider requests are unchanged.
