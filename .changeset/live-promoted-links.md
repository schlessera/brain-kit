---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

An answer whose turn-temp link was promoted into scratch now shows the link to the copy in the open conversation as soon as the turn has ended, with no reload and no marker (#1698). The server sends the turn's clients a new `message_links` frame (`{ sessionId, turnId, links: [{ from, to }] }`) for each promoted file, and the client rewrites those link destinations in that turn's answer, outside code, exactly as the saved answer was rewritten. A turn with no promotion sends nothing. For backend authors, the `promotion` activity event gains optional `aliases` listing other spellings of a link to the same file.
