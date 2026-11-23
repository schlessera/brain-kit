---
"@schlessera/brain-ui-server": patch
---

Share in-flight hardlink retention within a journal observation so each sealed inode version is copied once, while an inaccessible alias still allows another path to retain its bytes. Count purged index versions without including accounting-trigger writes on Bun 1.4.2.
