# Smart capture spike

This opt-in script measures #839. Ordinary tests run offline.

Set `EVAL_SCRATCH` to an empty directory outside the checkout and `TMPDIR` to
its `tmp/` subdirectory. Load `TYPESAFE_API_KEY` in your shell, then run:

```sh
bun run evals/839-smart-capture/run.ts label-check
bun run evals/839-smart-capture/run.ts measure
```

Inspect the label verdicts first: correct clear errors and remove ambiguous
cases before measurement. The script writes one results JSON and keeps raw
Claude stdout JSON streams outside the checkout. `summarize` recalculates its
tables without calling providers. `current-only` replays the stored Jev
judgments through deterministic writes and reruns the current comparison; it
retains the previously selected floor and calls. `resume-current` also retains completed current samples and dispatches only missing cells. It was used to correct setup
failures described in the decision record.

Claude Code uses the logged-in subscription with both Anthropic API-key
variables removed. At most two sessions run concurrently. The shipped `add`
skill is copied into each disposable brain and supplied unchanged in the
system prompt because restricted mode does not register the local `/add`
command. Its available file tools are confined to that brain. The declared
Bash allow list contains `brain add`, `brain search`, read-only `brain tags` and help; Claude's built-in
sandbox additionally denies reads of the checkout, raw transcripts and other
brains, with no unsandboxed retry. A standalone build of the shipped CLI is
reached through a command-filtering PATH shim; no symlinks point to the tree.
The clock supplies the corpus reference date while retaining real timeout
clocks. Full-text search is used; the compiled CLI has no sqlite-vec extension.

The candidate uses the shipped core Jev client, with one Choice for type, one
for the four-record shortlist plus `none`, and one binary Choice for each of
six vocabulary tags. All judgments are retained, including those overridden
by exact titles, explicit type requests or literal/explicit tags. A tuning-only
screen selects the lowest floor with the best sum of type, target and exact
set-of-tags correctness, requiring no wrong-target appends. Below-floor type
falls back to inbox, target to none, and semantic tag to absent. These are
question-level abstentions, including unused judgments. A transport/model
failure stops the comparison and is not a quality score.

The prototype writes literal captures with the shipped ingestion/frontmatter
helpers, explicitly preserving an empty selected tag set. Appends retain the
old metadata and tags. The baseline calls the shipped title matcher and
keyword extractor, but otherwise always chooses inbox. Types and targets are
scored against goldens; tag precision/recall count all emitted tags, including
out-of-vocabulary tags. The scorer checks every content Markdown file for
wrong-target changes and missing old or captured text. Missing literal capture text is flagged for semantic review; destructive loss is reported separately after the GPT-family author checks the rewritten text against the source. It does not assess
frontmatter loss, duplicate prose, non-Markdown side effects or date precision.
Repetition agreement compares type, target and sorted tags, not file bytes.

```sh
bun run test experiments/839-smart-capture.test.ts
```
