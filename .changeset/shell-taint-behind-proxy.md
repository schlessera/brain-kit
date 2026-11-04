---
"@schlessera/brain-ui-server": minor
---

**Breaking (pre-1.0, #3429):** on a governed or strict turn whose worker runs behind the turn egress proxy, shell commands no longer taint the session through the command classifier. Such a turn stops recording `taint` with `source: "fetching_command"` or `"unclassified_command"`; the proxy's `egress_connection` taint, recorded at the first admitted connection other than the inference relay, is the shell signal there. An ordinary command such as `brain diagram --help` or `cat notes/x.md` leaves the session clean, while web tools, other MCP servers, `workspaces/` and inbox reads through file tools, and marked files still taint. Turns without the proxy keep the classifier unchanged. Known gap: on a proxied turn, a shell command that reads an untrusted local file without opening a connection does not taint.
