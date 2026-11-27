---
"@schlessera/brain-ui-server": patch
---

Activity lifecycle reads fetch each turn's client timing receipt in their own statement instead of one query per lifecycle (#4802), and a lifecycle snapshot reads every run's sequence floor in one grouped query. An Activity subscribe and each pump batch that carries lifecycle changes now run a fixed number of statements however many lifecycles they return. The receipt keeps its byte cap in SQL, and the records and Activity frames are unchanged.
