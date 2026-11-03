---
"@schlessera/brain-backend-pi": patch
---
When two turns resume the same pi session at once, the one that loses the race now finishes its worker's teardown before its busy refusal settles (#3488). The losing worker has exited, its turn temp is closed and its stdio release has finished, so the process ledger charges only the winner's reservation. If the losing worker's cleanup is refused, the caller still gets the busy refusal, the backend log records a warning, and the reservation stays charged until a later abort confirms the cleanup. The winner's turn, the busy refusal and the result shapes are unchanged.
