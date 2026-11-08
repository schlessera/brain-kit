---
"@schlessera/brain-ui-react": patch
---

After clearing an old untrusted mark from the Marked untrusted list, focus now reliably lands on the next row. It used to move on the next animation frame, which could come before the closing dialog was removed, so focus was lost.
