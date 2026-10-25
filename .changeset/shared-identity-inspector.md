---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-ui-server": patch
---

Cut a native journal observation's own cost (#2872). The native brain manager runs its root and loop-device identity checks in one long-lived `python3 -I -S` interpreter instead of a fresh launch per check, with the same programs, paths and refusals. The journal releases the previous native checkpoint after the observation that superseded it is recorded, outside the hold that freezes the turn's workers, at most two pending per observed root; a commit past that waits as before. A release that fails there still stops every active turn and leaves its record partial, and shutdown drains pending releases and reports any checkpoint it could not release.
