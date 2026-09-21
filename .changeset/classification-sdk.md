---
"@schlessera/brain-ui-sdk": minor
---

`message_blocks` (protocol rev 4, additive) and the classification module
(D42). A host may classify a finished turn's assistant markdown into the
kit's answer blocks and send one `message_blocks` frame after the turn's
`result`; replayed history carries the same objects on `blocks`. The SDK
holds the deterministic half — `detectCandidates` walks a text part's
markdown for tables, ordered lists, timed lists, blockquotes and
key-value runs with exact character spans — and the catalogue that
generates one classifier request from the candidates and turns the answers
back into D41's `Block` union, re-validated against the block schema. No
network here: the transport is the server's.
