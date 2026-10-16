# Claude title-helper provenance at an offline origin

This measurement implements #2052's installed-runtime investigation and tests
an internal OTLP collector. It does not install that collector in production
turns or implement server ledger allocation. The selected policy retains
CLI-generated titles; [the cost decision](../../docs/decisions/cost-tracking.md#claude-generated-titles-and-helper-provenance-2052)
records the boundary.

Run from the repository root:

```sh
bun experiments/2052-title-provenance/run.ts --out /tmp/title-provenance.json
bun experiments/2052-title-provenance/run.ts --disable-nonessential-traffic --out /tmp/title-disabled.json
bun run test ./tests/claude-title-provenance.test.ts ./packages/ui-backend-claude/tests/title-usage.test.ts
```

The parent starts `bwrap --unshare-net` with the test network preload. The real
installed SDK and CLI use `createClaudeSdkTurn`'s interactive options,
permission wiring and worker launcher. Synthetic loopback serves Messages and
a separate authenticated collector receives OTLP logs. Isolated HOME/config,
synthetic credentials and fictional Odysseus content prevent borrowing provider
access. No paid or first-party requests are made. Namespace/launch/resume/result
failures fail the measurement.

Only API-request usage attributes are retained. Prompt, response, tool-detail
and raw-body logging are disabled. The capture excludes credentials, local
paths and session identifiers. Model names and tool counts never classify a
request's purpose. The collector is scoped to one CLI process, validates the
runtime source and token counts, and deduplicates request IDs (or process-local
event sequences when no request ID exists). Missing purpose/usage remains
unknown or partial; a duplicate with conflicting values is partial.

## Captured result

The two checked-in captures use SDK **0.3.293** / CLI **2.1.293**.

With the nonessential-traffic flag **unset**, the new session sends a
tool-free title-schema request followed by main; a fresh `query()` resuming
that session sends only main. All three use **the same Sonnet model**.
Each synthetic response reports 3 input / 5 output tokens. SDK main stream
receipts and terminal main-loop usage cover only main (3/5 per turn), while
cumulative per-model totals include title + main (6/10 then 9/15). The title
helper has no stream receipt. `ai-title` transcript entries appear.

The documented `claude_code.api_request` OTLP log event does expose
`query_source=generate_session_title`, the model, measured token counts,
estimated cost and request identity. The collector records one helper receipt
for 3/5 tokens and approximately 0.000084 USD on turn 1; no new title receipt
arrives on resume. This requires only the supported logs exporter, not beta
tracing or content logging. See the [upstream monitoring documentation](https://code.claude.com/docs/en/monitoring-usage#api-request-event).
A missing receipt on resume remains unknown coverage, not a statement that an
unseen helper would be free.

With `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, the same harness sends only
two main requests and no `ai-title` entries or helper receipts. The earlier
no-helper measurements using this flag do not establish behavior when it is
unset. This control also demonstrates why absence from one fixture cannot
prove first-party behavior.

The captured runtime `modelUsage.provider` is `firstParty` even at the fake
origin. It is not evidence of first-party traffic, a provider invoice or cache
savings. The measured costs are runtime estimates over synthetic usage.

## Accounting integration boundary

The collector proves production-accessible request provenance, but it is not
installed in ordinary turns by this change. Production integration must not
silently replace an operator's configured telemetry destination or enable
content logging. Export loss, disabled telemetry and malformed receipts must
retain unknown/partial coverage.

#2025 owns completed root/child pricing and source-qualified cumulative
reconciliation. Its `accountClaudeUsage` transaction is the allocation point:
identified title receipts must claim their matching portion of newly measured
auxiliary usage, leaving unmatched remainder explicitly unattributed. Adding
helper spend outside that transaction would count the same cumulative
remainder twice. Imported histories and rollback/high-water handling retain
#2025's semantics. A same-model main/title/subagent accounting fixture and
resumed helper double-charge mutation remain required at that integration.
Parser controls here use the same model for `sdk`, `agent:general-purpose` and
`generate_session_title`; they do not claim to be server accounting proof.

Collector mutations make the same-model test fail: accepting all sources
produces three helper receipts instead of one; dropping measured cost makes
`MEASURED_HELPER_SPEND_RETAINED_ONCE` fail; changing deduplication keys produces
two receipts instead of one. All were restored. Adding a placeholder `title`
to production SDK options makes the real-runtime test fail at
`TITLE_GENERATION_NOT_SUPPRESSED` after successful results; restoring passes.
These receipts prove collector classification/cost/deduplication and title
preservation, not completed server accounting or C5 metrics.
