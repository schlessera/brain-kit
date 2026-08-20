---
"@schlessera/brain": minor
---

Export `SCHEMA_VERSION` — the brain.db schema version core writes — from the
package entry, and make `brain doctor` read it instead of carrying its own copy
of the number.

The version used to be spelled out as a bare `8` in four unconnected places
(core's schema writer, the doctor check, `ui-server`'s two read floors, and the
integration-contract doc), so bumping it meant four silent edits and any missed
one failed at runtime rather than at build time. Consumers reading brain.db
directly can now import the floor they should gate on.
