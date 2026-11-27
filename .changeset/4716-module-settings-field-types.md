---
"@schlessera/brain-common": patch
---

`ModuleSettingsField` and `ModuleSettingsOption` are declared once, in the new `@schlessera/brain-common/internal/module-settings-fields` entry, and re-exported unchanged from `@schlessera/brain` and `@schlessera/brain-ui-sdk` (#4716). The two packages carried identical copies with nothing holding them equal. The new subpath is an internal entry with no compatibility promise; the promise for the two types stays with the entries that re-export them.
