---
"@schlessera/brain-ui-server": patch
---

Add the production Queue dispatcher behind the autonomous enablement gate. It routes arrivals through T0/T1 triage, runs agent-tier work and validated follow-ups in the restricted autonomous envelope, turns an exact Markdown proposal into a durable decision, and lets a follow-up apply exactly the approved tool, input and target once; any other change escalates and writes nothing. `createApp` still enables no dispatcher: no configuration, environment variable or default activates autonomous work, the internal poke keeps reporting `dispatchEnabled: false`, and operation-bearing approvals keep failing closed.
