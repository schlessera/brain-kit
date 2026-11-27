---
"@schlessera/brain-ui-react": patch
---

A conversation-task row keeps its `MessageBubble` memo while a later answer streams (#4752). The page hands the bubble the row's session and a stable reveal callback instead of a fresh element, and the task row selects only the key of the entry its button reveals; whether a recognition row introduces its activation is computed once per transcript instead of once per row per render. The rows draw the same content.
