---
"@schlessera/brain-geo": patch
---

The disk response cache now deletes old entries (#4812). Every distinct geocode, route, map or point-of-interest request added a file under `<cacheDir>/responses` and nothing ever removed one, so the directory grew without bound. After a request writes a new entry, the transport deletes entry files, and temporaries orphaned by an interrupted write, whose modification time is older than 30 days, at most once an hour per process. It uses the longest `cacheTtlMs` the configuration allows rather than its own, because the default directory is shared by every process on the machine. The prune is best-effort: an error while listing or deleting never changes the request's result. Request results, `brain geo --json` output and configuration are unchanged.
