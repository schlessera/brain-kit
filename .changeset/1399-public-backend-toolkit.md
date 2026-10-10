---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-ui-server": patch
---

`@schlessera/brain-ui-sdk/server` now exports the helpers both shipped backends use, so a third-party backend can give the host the same behavior and security posture without reaching into `/internal`. The new names, all `@experimental` until 1.0: the bridge-tool handlers (`handleAskUser`, `handleAskUserForm`, `handleAskUserList`, `handleAskUserRank`, `handleGetCurrentLocation`, `handleQueryActivity`, `handleRequestImageMask`, `handleShowBlock`, with `ImageMaskHandlerOptions` and `LocationHandlerOptions`) and `BRIDGE_TOOL_POSTURE`; the exec wrapper (`wrapCommand`, `validateExecWrapper`, `EXEC_WRAPPER_ENV`, `EXEC_KILLER_ENV`); the subprocess environment filter (`filterSubprocessEnv`, `parseSubprocessEnvExtra`, `SubprocessEnvAudience`); the lock keys (`BRAIN_LOCK_KEY`, `bashLockKey`); `describeRetry`, `resolveThinkingLevel`, `assertLoadedSdk`, `rtkRewriteCommand`; and the bundled `DEFAULT_CONFIRM_BASH_PATTERNS`, whose entries may still change between releases. Their behavior is unchanged. They are no longer exported from the unsupported `@schlessera/brain-ui-sdk/internal` entry; first-party code imports them from `/server`.
