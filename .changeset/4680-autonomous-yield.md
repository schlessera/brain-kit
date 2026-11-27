---
"@schlessera/brain-ui-server": patch
---

`BRAIN_UI_AUTONOMOUS_YIELD_AFTER_MS` now reaches the autonomous turns the inbox dispatcher starts (#4680). It was validated at boot and then dropped, so an autonomous lock holder always yielded after 20 seconds whatever was configured. Unset, the backend still receives the 20-second default. Production dispatch stays off; this applies wherever the dispatcher runs.
