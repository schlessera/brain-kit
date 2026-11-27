---
"@schlessera/brain-backend-pi": patch
---

Reading one pi session's history now opens its server-owned transcript `<sessionDir>/<id>.jsonl` directly when that plain file's header names the session and this brain, instead of listing and parsing every transcript in the session directory (#4858). Any other case, including transcripts under older SDK-managed names, takes the listing path with the same result as before.
