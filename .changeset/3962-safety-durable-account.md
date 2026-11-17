---
"@schlessera/brain-ui-server": minor
---

A chat stays continuable after the login that started it is pruned (#3962). Every owner sign-in is its own principal, and cleanup deletes a login 30 days after it expires or is revoked; the chat's safety history then named a principal nobody could vouch for, so every later turn was refused as a safety principal mismatch. The host now stores the account with the safety history when it writes it, from the principal's own row, and another owner login keeps continuing, reading and reviewing that history and its taint. The stored account is no credential: a pruned, expired or revoked login regains nothing, another account is still refused, corrupt or contradictory evidence is refused, and history whose login was already pruned before upgrading stays unknown. Attribution and safety records are not rewritten.
