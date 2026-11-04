---
"@schlessera/brain-ui-react": patch
---
Fix two draft states being lost when the page reloads. If a draft's first save got no answer and the reader then emptied the draft, the host refresh after a reload brought the cleared text back. Now the emptied draft is kept on this device, and after the reload the client deletes the copy the host may hold. If a new chat's first message was accepted while a newer save was still out, the bind to its session was dropped, so the host kept an unbound draft. Now the bind survives the reload and completes. Records written by older versions restore as before.
