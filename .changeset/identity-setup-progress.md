---
"@schlessera/brain-ui-sdk": minor
---

**Separate-UID setup timeouts name their last step (#3664).** When a separate-UID worker's identity supervisor misses the 5,000 ms readiness deadline, the refusal's requirement now carries the supervisor's last recorded setup step in its existing parenthetical detail. For example: `worker_identity_setup_timed_out (step: launch-sent, ms: 312, sinceSpawnMs: 340)`. The steps are `started`, `listening`, `launch-sent`, `launch-acked`, `status-read` and `mounts-acked`. `step: none` means no step was recorded. `step: refused (…)` means the record was oversized, a link or malformed, and was not read. Any launch stderr follows the step after a `; `.

The supervisor keeps that one private `0600` record in the server's own `0700` broker directory, which the broker's close removes. The record never reaches the worker. `errorClass` stays `worker_host_unsupported`, and the deadline, every supervisor bound, cleanup and identity verification are unchanged.
