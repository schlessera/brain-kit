---
"@schlessera/brain": minor
"@schlessera/brain-ui-sdk": minor
---

Hosted `brain sync` no longer launches an agent CLI that cannot log in (#3243). A credential-free maintenance worker now sets `BRAIN_AGENT_RUNNER_UNAVAILABLE=1`. When a conflict needs judgment there, bare `brain sync` reports `agent.reason: "no-runner"`, exits `3` with nothing pushed, and prints a "judgment unavailable in hosted maintenance; resolve it manually" notice that names the commands to run.

A failed `claude` runner's error now keeps the CLI's own words: its result text, the errors its result listed, and the end of its stderr.

`brain sync pull` merges a conflicted `.stats-history.jsonl` by day itself. It keeps both clones' days and the later recording of a shared day, so a brain without the history's `.gitattributes` union line no longer needs judgment for it.
