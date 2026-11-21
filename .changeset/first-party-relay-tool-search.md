---
"@schlessera/brain-backend-claude": patch
---

Keep unqualified production tool search off for new interactive sessions, verify its native effective setting before releasing the prompt, and preserve legacy inherited settings. Retain each session's recorded roster independently of future removal lists, and refuse missing session context before recreating cache inputs.

Apply current mandatory exclusions over retained rosters, record the original legacy environment, and validate retention before persisting a prompt. Direct API turns use the same effective-setting prompt gate.
