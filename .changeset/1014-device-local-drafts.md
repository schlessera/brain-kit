---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Keep the composer's drafts on this device across a reload. The authenticated `GET /api/vpn-check` probe now also returns `accountKey`, an opaque name for the signed-in account on this host and brain root that stays the same across sign-out and sign-in as the same owner, differs between hosts and roots, and is never given to an agent principal. The client writes every draft (text and images), the voice review text, the selection, the focused element and the transcript position to IndexedDB in that account's partition a moment after each change, and opens the partition only while it holds the same key. After an authenticated boot as the same account they come back: the text, images and review text, the selection and focus, then the place in the transcript. Another account restores nothing. A write the browser refuses shows `Couldn't save your draft on this device.` in the composer's hint and is never reported as kept, while editing goes on. Staged track files still live in this tab only. The stored drafts are not encrypted and are not protection against someone with access to the device.
