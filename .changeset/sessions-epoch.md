---
"@schlessera/brain-ui-server": minor
"@schlessera/brain-ui-react": minor
---

Password session cookies carry a strict server-side epoch. Signing out or revoking a passkey globally invalidates every outstanding cookie and closes every open WebSocket; callers without a current valid session cannot trigger invalidation. The Security panel now labels the action “Sign out everywhere.”
