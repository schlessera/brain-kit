---
"@schlessera/brain-ui-server": patch
---

The triage eval gate (`eval:triage`) is now an exit code, so a wrapper can
enforce it: 0 when every selected configuration passes, 1 when one fails the
gate, 3 when one was selected and never judged (`NO DATA`, a rejected effort,
a crashed job), 2 when the runner refuses to start. Before, every run exited 0
and the verdict lived only in the printed table. `EVAL_BENCHMARKS=<path>`
redirects the results file for a scratch run.
