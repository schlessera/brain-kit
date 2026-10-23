---
"@schlessera/brain-ui-server": patch
---

A provider policy that selects a folder inside another selected folder, such as `me/**` beside `me/sub/**`, no longer fails every hosted turn at worker launch. The nested folder is hidden by its ancestor's mask, and the masks, retention, private index and hardlink check share that one set.
