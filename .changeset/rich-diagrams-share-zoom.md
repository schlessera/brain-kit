---
"@schlessera/brain-ui-react": minor
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-server": minor
"@schlessera/brain-backend-claude": minor
"@schlessera/brain-backend-pi": minor
---

Added: mermaid diagrams get their own share menu (PNG / PDF / SVG / source) and a
full-screen pan-and-zoom viewer, opened by tapping the diagram.
Added: a chat-surface brief appended to the agent's system prompt —
`buildSystemPromptAppend({ client, tools })` — covering diagrams, `<share>`
blocks, wikilinks, raw-HTML and tool-narration rules, the ask-user and location
tools, and what the reader's device can do. Each backend declares its own tool
names (pi has no location tool), and both take a `systemPromptAppend` option to
override the whole brief.
Added: `chat_message` frames carry an optional `client` field
(`ClientEnvironment`: form factor, touch, standalone, camera, microphone,
geolocation, share sheet, viewport, locale, timezone), feature-detected in the
browser and validated strictly at the boundary. The Claude backend rebuilds its
system-prompt append per turn from it.
Changed: diagrams render in a theme built from the app's own tokens instead of
mermaid's stock dark/neutral themes; exports use the matching light theme.
Changed: `MermaidTheme` is now `"dark" | "light"` (was `"dark" | "neutral"`),
`ShareMenu`'s `renderTrigger` also receives `status` and `icon`, and the
server-internal `handleChatMessage` takes an options object.
