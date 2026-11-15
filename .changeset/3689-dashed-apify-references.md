---
"@schlessera/brain": patch
---

`brain apify inspect`, `prepare`, `run`, `status`, `results` and `abort` now accept an Apify reference or run handle that starts with `--` in the documented positional form (#3689). These are random base64url values, and about one in 4,096 began with `--`. Until now the CLI refused those as `Unknown flag`. References keep their shape and entropy, stored values need no migration, and the `--` separator form still works.
