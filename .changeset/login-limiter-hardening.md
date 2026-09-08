---
"@schlessera/brain-ui-server": minor
---

Login limiting counts failures, not attempts. Password failures count per IP (5/min) and globally (100/min); passkey `login-verify` has its own budget and counts only an assertion that matched an outstanding challenge and then failed verification. A bounded in-flight reservation (2 per IP, 8 per process, separate pools for password and passkey) keeps argon2id and WebAuthn verification from being flooded, buckets evict on window expiry and a size cap, and a blocked client is refused before its body is read. Password mode logs once when `X-Forwarded-For` arrives while `TRUST_PROXY` is off.
