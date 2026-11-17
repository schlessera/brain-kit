---
"@schlessera/brain-ui-react": patch
---

A passkey-only login screen no longer starts the passkey autofill ceremony. That ceremony attaches to the password field's autofill, and a passkey-only screen has no password field. Every load used to spend one of the host's ten login-options requests per minute, leave an unused challenge behind and log a `[passkeys]` warning, so a few reloads could lock out the "Sign in with a passkey" button. The button works as before, and screens with a password field still offer the passkey in its autofill.
