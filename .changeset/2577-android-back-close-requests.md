---
"@schlessera/brain-ui-kit": patch
"@schlessera/brain-ui-react": patch
---

Android back now closes an open panel instead of leaving the app. The phone destination drawers (Sessions, Files, Settings), the Settings and Files panes from 900px, and the dictation field each take a close request (Escape, the back gesture) through one shared `CloseWatcher` helper, close once and return focus to their opener. Where `CloseWatcher` is missing, Escape still closes them. A modal opened over a panel still closes first. A dictation take that is finishing, or a panel that cannot be dismissed, ignores the request. Escape in the share menu or the passkey rename field inside a panel now closes only that menu or field.
