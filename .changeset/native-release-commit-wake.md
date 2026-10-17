---
"@schlessera/brain-ui-sdk": patch
---

Complete native checkpoint release when a reference into the checkpoint is dropped just after its delete. The manager now wakes the Btrfs transaction thread while waiting for reclamation, rather than leaving the deleted root for the next 30-second commit pass, which exceeded the release deadline and reported an unknown outcome. A reference that stays held still reaches the unchanged deadline.
