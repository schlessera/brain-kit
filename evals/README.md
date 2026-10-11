# Evaluation cases

`cases/<issue>-<slug>.json` holds the authored Odysseus cases of an open
[#838](https://github.com/schlessera/brain-kit/issues/838) candidate: each
case's id, split, inputs and expected labels, exported once from the retired
spike harness named in its `source` field. The files carry data only, with no
harness, freeze or receipt; a candidate's lean harness reads them and adds the
cases it is missing.

## Other models

Each harness's current-path arm accepts `EVAL_CLAUDE_MODEL` (default
`claude-sonnet-5-5`). A non-default model reuses the stored Jev, floor and
baseline rows from the Sonnet results and writes
`results-<model>-<date>.json` beside them. 839 and 1416 also accept
`EVAL_CLAUDE_EFFORT`. The Haiku 5.5 reruns of 2026-10-11 are summarized in
[the Haiku investigation](../docs/investigations/haiku-5-5-current-path-investigation.md).
The [eval lab epic](https://github.com/schlessera/brain-kit/issues/1603)
replaces these per-harness overrides with one interface and runner.
