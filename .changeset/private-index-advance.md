---
"@schlessera/brain-ui-server": patch
---

A provider-restricted hosted turn after one that added or edited notes no longer updates its private search index before it starts (#2833). After each turn's index refresh, the server brings its kept build up to a fresh checkpoint of the brain, off the turn path, under the same rules as before: new notes are added, a changed, removed or newly masked note is rebuilt from nothing, and anything it cannot prove drops the build so the next turn makes a clean one.
