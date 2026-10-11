# Interpreted briefing comparison

This opt-in spike compares the shipped `whatsup` skill on Sonnet 5.5 and
Haiku 5.5, `generateBriefing` alone, and Jev Choice selecting up to three
detail files before Haiku synthesis. It changes no product behavior.

The twenty synthetic Odysseus brains use `2026-07-12`: six tuning, fourteen
held-out. Some are counterfactual missing/completed checks, rather than a
second account of the canonical voyage. Cases and factual/relevance goldens
are in `../cases/1416-interpreted-briefing.json`.

Set an outside-repository scratch directory and load credentials without
printing them. Scratch must have room for disposable brains and full CLI
transcripts; do not use a full temporary filesystem.

```sh
export RUN_DIR="$(pwd -P)/../briefing-evaluation"
mkdir -p "$RUN_DIR/tmp"
export TMPDIR="$RUN_DIR/tmp"
set -a; . ~/.env; set +a
bun evals/1416-interpreted-briefing/measure.ts --scratch "$RUN_DIR" --labels
bun evals/1416-interpreted-briefing/measure.ts --scratch "$RUN_DIR" --live
```

Without either flag, only the deterministic arm runs, keyless and offline.
Use `--output "$RUN_DIR/results.json"` for a smoke run; otherwise every
invocation writes the committed results path. Use a fresh scratch directory
for a new measurement. Cached raw responses resume the same measurement,
not a changed prompt or corpus. The simple call ledger counts dispatched
calls, including failed attempts. It does not measure spend.

Claude calls remove credential-like environment variables, including both
Anthropic key variables, and use the logged-in
subscription. The harness permits at most two simultaneous Claude processes.
Jev uses the shipped core client, `TYPESAFE_API_KEY`, and `jev-1.13.0`.
Free-text scoring uses `gpt-6.1-sol` through `OPENAI_API_KEY`, blinded to arm
identity. Identical text on identical sources receives one verdict shared
across repetitions. One Sonnet pass checks every authored golden before runs.

Each current-path brain has only its case files, index, config and an actual
copy of the shipped skill. A PATH shim invokes the shipped briefing generator
with its existing evaluation-clock argument. No symlinks or source paths are
placed in a brain. Claude's restricted file tools and a small exact-command
hook permit only `brain briefing`, the installed skill, and reads inside that
brain, denying malformed hook input. Directory names are opaque hashes.
MCP and other tools are disabled. Full stdout JSON stays in scratch;
the results retain sanitized tool requests and any flagged access attempt.

Before held-out dispatch, the confidence floor is chosen on tuning alone
from `[0, 0.2, 0.4, 0.6, 0.8]`, minimizing action-selection errors, with the
lowest floor breaking ties. Completed work is FYI even when its deadline is
a briefing lead. Provider failures or any low-confidence answer return the
complete deterministic report. The hybrid always retains the mechanical
report; Jev chooses detail reads, not permissions, edits, dates or counts.

The predefined adoption gates require at least 95% required-fact recall,
90% complete-case correctness and 90% agreement on scored outcomes, zero
injection/destructive-advice/access vetoes, and quality at least matching
Sonnet. Complete correctness includes dates/counts, priority and traceability
with no invented claims. Agreement compares factual and quality verdicts,
not byte-identical prose. Any proposed cascade must justify its extra call
from measured failures; this spike does not assume one is useful.

The decision record distinguishes these future-run hardenings from the
measured runs, and explains the result and its limits. Ordinary
tests never import the live harness or need keys or a network.
