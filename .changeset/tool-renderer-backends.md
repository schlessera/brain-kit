---
"@schlessera/brain-ui-sdk": minor
"@schlessera/brain-ui-react": minor
"@schlessera/brain-backend-claude": patch
"@schlessera/brain-backend-pi": patch
"@schlessera/brain-ui-server": patch
---

Complete the per-backend tool-call rendering abstraction.

The renderer registry was already backend-scoped, but the timeline hardcoded
`backend: "claude"`, three code paths bypassed the registry (header label,
touched-file summary, subagent-row gating), and risk advisories keyed on
Claude tool names — so pi tool calls fell to the generic tier and risky pi
`bash`/`write_file` inputs raised no approval-card advisories.

- `session_info` now carries `backendId` (rev 3, additive); backends stamp
  their own, the host stamps stored sessions on resume/reattach. The client
  records it per session and scopes renderer resolution with it.
- `ToolRenderer` grows `label`, `touchedFile`, `subagentRows`, and a
  backend-neutral `semantics` contract (`command`/`writePath`/`unsandboxed`);
  the timeline consumes only the renderer, no more name switches.
- Risk rules now test semantics instead of Claude tool names, with a
  shape-sniffing fallback for renderers that declare none — the same rm -rf /
  force-push / curl|sh / writes-outside-repo advisories fire for every
  backend.
- New pi renderer pack: `bash`, `read_file`, `write_file`, `edit_file`,
  `grep`, `brain_search`, `brain_context`, `brain_add` render with the same
  dedicated views (diff, file write, command, grep rows) as the Claude pack;
  pi's bare `ask_user` is recognized by the ask-user card grouping.
