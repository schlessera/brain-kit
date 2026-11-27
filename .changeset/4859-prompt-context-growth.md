---
"@schlessera/brain-ui-sdk": patch
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
---

The session prompt-context file no longer keeps every acknowledged turn's host facts: acknowledging a turn moves its facts to the delivered set and removes them from the stored turn, so the file grows by one small record per turn instead of the whole fact set (#4859). History replay in both backends reads the file once per history read through the new `userTexts()` lookup instead of once per user entry. The text sent to the provider, the retained append and the delivered facts are unchanged, and files written by earlier versions replay and acknowledge as before.
