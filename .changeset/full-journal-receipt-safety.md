---
"@schlessera/brain-ui-server": patch
---

Clear ended turns from active journal attribution before finish writes can fail, and mark a refused finish record partial. Admit checkout receipt tables only when capturing a checkout so upgrading a nearly full journal preserves ordinary writes. Keep history, retention and operational backups usable before those tables exist.
