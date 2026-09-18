---
"@schlessera/brain-ui-react": minor
---

The six fetch-on-mount components are split into a container that owns the
request and its cancellation, and a view rendered from props on kit
primitives: `PushToggle` renders `PushSwitch`, `LoginScreen` renders
`LoginForm`, `WebSearchSection` renders `WebSearchChain`, `PasskeyTab` renders
`PasskeyList`, `SkillsTab` renders `SkillsList` and `SkillEditor`, `AddPanel`
renders `AddForm`, and the sync and briefing panels render `StreamingOutput`
and `BriefingOutput`. Switches are the kit's `Toggle`; buttons are the kit's
`Button`; loading and empty states are the kit's `Placeholder`. The muted
foreground colour follows the kit's floor to `#9a96a1`.
