---
"@schlessera/brain-ui-react": patch
---

Open other version now always ends at the other version's content or says why not. A version moved to a new draft id opens where it lives now; one with no chat, or whose chat turns out to be gone, opens on its own in the new-chat view with the hint "Other version · not in a chat yet". A switch cancelled by a change of view, a failed device read, or a version found nowhere adds the reason to the draft indicator. Text typed or pasted while a Send's snapshot is unacknowledged is held in the field with the hint "New text waits until your message is saved" and goes into the draft once the brain answers, instead of being dropped.
