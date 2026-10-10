---
"@schlessera/brain-backend-pi": minor
"@schlessera/brain-ui-server": minor
---

Run hosted pi sessions, extensions and shell tools in isolated workers before any writer initializes. Permission and bridge requests use bounded protocol pipes; exact Markdown edits use the server-owned application route with existing approvals. Masks reuse the shared server-owned PNG operation with Pi’s existing filenames and result paths. Cancellation ends the process tree and preserves committed edit receipts.

Breaking pre-1.0 migration approved by the isolated-writer ruling: shell writes now stay in scratch, while the brain is read-only. Session JSONL defaults to `~/.local/state/brain-kit/pi/<SHA-256 of canonical brain path>/sessions`; configured session and native agent directories must be outside the brain and its ancestors, without aliases. Move existing transcripts to an external directory to resume their unchanged ids/history. Unsupported worker hosts visibly refuse. Credential/egress containment and autonomous enablement remain separate work.
