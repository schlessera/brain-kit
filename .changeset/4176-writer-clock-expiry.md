---
"@schlessera/brain-ui-server": patch
---

Four more write-worker procedures now refuse a login that expires while the request waits for the write worker (#4176). Each stamped the request's time before that wait and checked the login's expiry against the stamp inside the writer, so a login that expired in the meantime still passed. Saving or binding a session worker profile now refuses it with `401`. A push subscription binds no device and answers `false`. A storage notice attempt returns no attempt and records nothing. A hygiene review command refuses it as `HygieneAuthorityError`. Each check now reads the clock inside the writer. The stamp still records `updated_at`, `created_at` and `attempted_at`, drives the draft-preference cleanup, and judges the storage notifier's reversed-clock guard, eligibility windows and quiet hours. Revocation is unchanged, because it was already read from the row inside the transaction.
