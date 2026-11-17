---
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": patch
---
The composer's paperclip now says what its menu offers. The kit `Composer` gains an optional `attachLabel` prop for the attach trigger's accessible name, which defaults to "Attach — photo, camera, files". A pointer sees the same name as a tooltip after 400ms of hover, or at once on keyboard focus. Escape or opening the menu dismisses it, and touch screens never show it. When live conversation is available, the app names it in the trigger ("Attach — live conversation, photo, camera, files") and in the phone attach sheet's subtitle.
