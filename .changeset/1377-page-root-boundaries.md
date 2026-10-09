---
"@schlessera/brain-ui-react": minor
---

A page that throws, or a lazy chunk a redeploy has replaced, no longer blanks
the app. `AppShell` answers in place of the page, with a retry, a way back to
Chat and a reviewed copy of the details, while navigation keeps working. A
stale chunk reloads by itself when that is safe. Shells can wrap everything in
the new `AppErrorBoundary` for a last-resort reload screen.
