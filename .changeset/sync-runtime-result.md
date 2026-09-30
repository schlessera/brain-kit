---
"@schlessera/brain": minor
"@schlessera/brain-ui-server": minor
---

**Breaking:** `brain sync` with no verb now prints one JSON result in machine mode (`--json`, or stdout not a TTY), where it used to print its text report whatever the output mode (#290). The result is `{ run, agent }`: `run` is the envelope `brain sync run --json` prints, report included, and `agent` says whether the `/sync` agent was invoked — `{ invoked: false, reason: "not-needed" | "no-runner" }`, or `{ invoked: true, runner, outcome, runtime, text, error? }`, where `runtime` is what that run reported about itself (`{ name, version }`, `version` null when it gave none) and null when it reported nothing. The built-in `claude` runner reports the Claude Code version from the session's `init` event; nothing is ever probed. Human mode (`--human`, or a terminal) is unchanged, and so are the exit codes and when the agent is called. A machine-mode agent failure prints the result as well as its error, and still exits `2`. Migration: a caller that read bare `brain sync` stdout as text passes `--human`, or reads `run.report` and `agent.text` from the result.

`AgentRunner.run` and `runStreaming` accept an optional `onRuntime` callback, which a runner calls with what executed the run (experimental seam; runners that do not call it keep working).

The server's sync paths ask for the result and record it on their own run's root span with the attributes chat's `runtime_observed` writes (`brain.runtime.name`/`version`), plus `brain.sync.agent`: the in-process scheduler now writes a root span for each of its runs, and the container cron wrapper reads the result of the base `sync` job only — the crontab line becomes `sh -c 'brain sync --json && brain index >&2'`, and the log still gets the readable report. `/api/status` adds `runtime.sync`: the latest sync run's own invocation state and runtime, and the last run that observed a version, with its run id and times. The UI's manual sync passes `--human`.
