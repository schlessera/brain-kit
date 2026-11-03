---
"@schlessera/brain": minor
"@schlessera/brain-ui-server": patch
---
A module now has a durable state area, `<brain>/.brain-ui/modules/<module-name>/` (#3380). Module commands get it as `ctx.stateDir()`, which creates the directory and its own `.gitignore`. `@schlessera/brain/module` exports `MODULE_STATE_DIR`, `moduleStatePath`, `moduleStateDir` and `ModuleStateError`. A scheduled module job running in a maintenance worker writes its state through the worker's data root, and the run publishes it back, so the next run reads it. A module command or cron job that writes a read-only host path now fails with a message that names the host execution boundary and the state area, instead of a bare `EROFS`.
