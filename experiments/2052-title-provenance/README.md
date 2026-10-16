# Claude title-helper provenance at an offline origin

This measurement exercises #2052's automatic production OTLP collector
through the real interactive SDK options. Host dispatch tests exercise its
separate Activity allocation inside the cumulative accounting transaction. The selected policy retains
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

Ordinary interactive/voice turns create the authenticated collector lazily at
native worker spawn. Existing operator telemetry environment and opt-outs are
preserved; the collector is not installed for those launches or autonomous
turns. Export loss, disabled telemetry and malformed receipts retain
unknown/partial coverage. Worker/exporter shutdown settles before a
`claude_title_usage` evidence event and the held terminal result are released.
The collector never logs prompts, responses, tool details or raw API bodies.

The host allocates supported title receipts inside #2025's existing
`accountClaudeUsage` transaction, from their matching portion of newly measured
auxiliary usage. A `Claude session title` Activity run retains that usage and
measured cost once; unmatched remainder stays unattributed. Receipt IDs survive
catalog restart, so stale exports cannot claim later unrelated auxiliary work.
Incomplete joins cannot invent allocation; the raw title evidence remains on a
partial/unpriced unattributed run. Imported histories, cancellation and counter
high-water handling retain #2025's semantics. Main root/child usage and
first-main-request stream diagnostics never include the hidden title request.

The server dispatch control uses the same model for main, child, title and
unattributed calls, then resumes twice with duplicate/stale helper evidence.
Main/cache usage remains 10/20/5, title usage is 1 once, unknown usage is 2+2,
and overall/session spend is 160 under the fixture's four unit token rates.
Mutating title cost into main, dropping title spend or charging stale helper
receipts again fails the corresponding Activity/overall assertions. Restoring
the implementation passes. Before integration, restoring main's bridge and
catalog sources makes `TITLE_ACTIVITY_MEASURED_ONCE` fail with no title run.

`capture-sdk-0.3.293.json` and `capture-disabled-sdk-0.3.293.json` preserve the
original investigation receipts (head `583f3cfbb`). The integrated capture
exercises the automatic production collector; the operator-exporter runtime
control proves configured telemetry is retained and attribution stays unknown.

Collector mutations make the same-model test fail: accepting all sources
produces three helper receipts instead of one; dropping measured cost makes
`MEASURED_HELPER_SPEND_RETAINED_ONCE` fail; changing deduplication keys produces
two receipts instead of one. All were restored. Adding a placeholder `title`
to production SDK options makes the real-runtime test fail at
`TITLE_GENERATION_NOT_SUPPRESSED` after successful results; restoring passes.
The original collector receipts retain their original source identity; the
new dispatch and integrated-runtime receipts prove the production allocation.
No fake-origin receipt establishes a provider invoice or cache savings.
