---
"@schlessera/brain-backend-pi": patch
---

A pi worker's refused turn-temp close now passes to the cleanup reconciler only once the teardown that awaited it has ended (#3488). Before, the hand-off happened when the close was refused. Both the loser of a concurrent duplicate resume and a prompted turn still wait for the bounded stdio release after that close, so a reconciler retry that came due during the release made a second close attempt before the busy refusal or the turn settled. The order of exit, close and stdio release is unchanged. A refused close still keeps its reservation charged, is still reported, and is still retried by the reconciler and by a later abort.
