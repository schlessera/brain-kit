---
"@schlessera/brain-ui-sdk": minor
---

Tighten pre-1.0 backend conformance: the published testing harness now requires
a permission probe and checks denied mutations, enforced allowlists, no-grant
turns and rejection before runtime execution. Backends that silently ignore
requested restrictions no longer conform, and existing harnesses must implement
`permission(scenario)`. Add the published `runBackendModuleContract` descriptor
suite for profile parsing and resolution. Ordinary-turn defaults are unchanged.
