---
"@schlessera/brain-ui-react": patch
---

Say which backend to fix when Continue on another backend cannot run because the other backends are set up but none of their profiles can run. The entry in the locked model picker, a session row's menu and the desktop palette stays disabled, and now names every such backend, as `useBackendName` does, followed by the reason, for example `pi needs credentials` or `pi, codex need credentials`. It reads `can't run now` instead when any of those profiles reports another reason. `no other backend set up` is now shown only when no other backend reports any profile. `useBackendName` now falls back to the label of a profile that cannot run before it falls back to the backend id.
