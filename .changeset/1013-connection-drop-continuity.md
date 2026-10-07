---
"@schlessera/brain-ui-kit": patch
"@schlessera/brain-ui-react": patch
---

Connection drops no longer move or reset what is on screen. The composer's hint line stays one line high (text that does not fit ends in an ellipsis), so the offline reason arriving or leaving no longer moves the field. A draft whose save is still on its way keeps the save line's place under the composer. Reconnecting in the middle of a running turn reattaches to it: the host's greeting no longer ends the stream in view, and a history replay keeps the messages already drawn (and their nodes, times and the reader's scroll position), so the answer keeps streaming into the same message. A track upload that fails in transit just before the page sees the connection go now waits and resumes with the connection instead of showing a failure.
