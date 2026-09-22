---
"@schlessera/brain-ui-react": patch
---

A stray click on the backdrop no longer cancels `brain sync`. `SlidePanel`
takes a `closedBy` prop in `<dialog closedby>`'s vocabulary — `any` (the
default, light dismiss), `closerequest` (Escape only) or `none` — and the
header's X closes the drawer under every value. The sync panel is `none`
while the job runs and `closerequest` once it has finished, so the log stays
until it is dismissed deliberately; Settings is `none` while a credential is
being minted or is still unacknowledged, and its close control now works
there instead of silently doing nothing. The drawer's X also has an
accessible name (`Close <title>`).
