# Routing-only smart capture spike

This opt-in script measures #1593: whether code plus Jev can decide smart
capture's type and append target while the LLM keeps tagging. Ordinary tests
run offline.

Set `EVAL_SCRATCH` to an empty directory outside the checkout and `TMPDIR` to
its `tmp/` subdirectory. Load `TYPESAFE_API_KEY` in your shell, then run:

```sh
bun run evals/1593-routing-only-capture/run.ts measure
bun run evals/1593-routing-only-capture/run.ts summarize
```

`measure` resumes from the results file: stored Jev judgments, frozen floors,
tag replies and completed current-arm cells are kept, and only missing calls
are made. `MAX_JEV_REQUESTS` (default 260) stops Jev dispatch. Claude Code
uses the logged-in subscription with API-key variables removed, and stops on a
usage limit or active overage. `apply-reviews FILE` records the cross-family
semantic review of current-arm writes that did not keep the literal capture.
`EVAL_CLAUDE_MODEL` swaps the model for the current arm and the tag step; a
non-default model writes `results-<model>-2026-10-11.json`, seeded with the
stored Jev judgments and frozen floors. `EVAL_CLAUDE_WIDTH` (default 2) caps
concurrent Claude sessions.

The cases are `evals/cases/1593-routing-only-capture.json`, authored fresh for
this spike and label-checked once by a different model family. Target-ambiguous
cases were dropped; tag-ambiguous cases are scored for type and target only.

**Current arm.** The shipped `add` skill on `claude-sonnet-5-5`, in a
disposable brain, set up as in the #839 harness: the skill is installed and
supplied unchanged in the system prompt, Bash allows only `brain add`,
`brain search`, `brain tags` and help through a filtering shim over a standalone
build of the shipped CLI, and the sandbox denies reads of the checkout, raw
transcripts and other brains.

**Candidate.** Code decides exact append-match titles (the shipped
`classifyContent` rule), explicit `Capture as <type>.` requests and explicit
`Tags:` lines. Jev `jev-1.13.0` answers two Choices: type, with the policy's
type meanings as criteria, and target, from every append-match record plus
`none`. Each has its own floor, calibrated on tuning only: target takes the
floor with no wrong-target append and the most correct targets, ties toward the
higher floor; type then takes the most correct floor, ties toward the lower.
Below the floor, type falls back to note and target to none. For a new
document without explicit tags, a tool-less Sonnet call proposes tags, given
the decided type. The writer reads only the `tags` array from that reply. An
append keeps the record's metadata and tags.

The deterministic writer appends only to a shortlisted append-match record
revalidated on disk, as a dated section after the unchanged old body; anything
else is created through shipped ingestion with an explicit type, which never
appends, and its tag set is written exactly. The results' `enforcement` field
checks every candidate write against its routing.

**Baseline.** The shipped title matcher and keyword tagger, otherwise the
inbox.

**Regression.** The candidate's routing, at the frozen floors, on #839's
held-out inputs. These are prior inputs, reported separately and not as new
held-out evidence.

```sh
bun run test experiments/1593-routing-only-capture.test.ts
```
