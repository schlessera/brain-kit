---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": patch
---

Define the supported backend permission toolkit and record its signatures and reachable types. Permission behavior and runtime policy values are unchanged.

Breaking before 1.0: SDK `/server` no longer exports `DEFAULT_CONFIRM_BASH_PATTERNS`, `ARCHIVING_UPDATE_REASON`, `archivesDocument`, `bashCommand`, `SubprocessEnvAudience`, `SUBPROCESS_ENV`, `filterSubprocessEnv` or `parseSubprocessEnvExtra`. Claude's root no longer exports `DEFAULT_CONFIRM_BASH_PATTERNS` or `VOICE_ALLOWED_TOOLS`; pi's root no longer exports `DEFAULT_PI_ALLOWED_TOOLS` or `TOOL_RISK`. First-party consumers use the owning package's explicit `/internal` entry at the same lockstep version; those paths have no compatibility guarantee. External authors use the documented `/server` permission operations and configurable policy formats. Subscription-auth helpers remain public protocol API.
