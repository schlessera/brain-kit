---
"@schlessera/brain-ui-kit": minor
"@schlessera/brain-ui-react": minor
---

Compose Markdown fences through CodeBlock with exact source copy and a
kit-token syntax theme in both themes. CodeBlock accepts highlighted
children and a host-owned head action; wrapping preserves full commands.

Pre-1.0 breaking change approved in #1142: CodeBlock no longer defaults to
bash or a sample command and draws no action-less copy glyph. Consumers
must pass lang explicitly when wanted, code or children for content, and
an action for a real control. Native wrap=false scrolling is retained.
