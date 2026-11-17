---
"@schlessera/brain-backend-claude": patch
---

The Claude backend now builds a turn's permission wiring and SDK options in separate steps. Permission wiring is split into its native-file guards, enforcement hook, `canUseTool` callback, mutating hook and rewrite hooks. SDK options are split into the tool roster, the turn environment, the sandbox note and the prompt context. Permission decisions, the tool list and its order, and the system prompt are unchanged.
