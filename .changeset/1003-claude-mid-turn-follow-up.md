---
"@schlessera/brain-backend-claude": minor
---

Deliver messages sent during a running Claude turn into that turn, the way Claude Code does: the message reaches the model beside the next tool result, without interrupting the running step. The backend now declares `capabilities.followUp: true` and implements `followUp()`, so hosts send mid-turn messages live instead of queuing them as the next turn. A message sent while the final answer is being written runs before the turn ends, and the turn still ends on one `result` that counts both runs.
