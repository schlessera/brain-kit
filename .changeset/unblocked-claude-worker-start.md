---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
"@schlessera/brain-backend-claude": patch
---

Keep the hosted server answering while the remaining worker checks run. A Claude turn now claims its session at once and then awaits its worker host probe, and a Claude worker's probe and bubblewrap launch are awaited behind the deferred spawn instead of inside the SDK's synchronous callback. A separate-UID worker's exit is polled without blocking, and so are the separate-UID maintenance launch and the scratch mask's git ignore check. The checks, their order and their refusals are unchanged: a refused probe still rejects the turn and leaves no turn behind, and a worker that does not start still names the turn's failure with its own error.
