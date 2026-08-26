---
"@schlessera/brain-ui-react": minor
---

Activity: name subscription-billed spend, and make the run detail a full view.

- **`subbed`, not `free`** (span-bits): a $0 effective cost now reads
  `subbed` when the run was subscription-billed and `free` only when the
  rate itself is zero (an OpenRouter free tier, say). Both are $0 additive,
  but only one of them stays $0 once the seat plan lapses, so the run rows
  and the run-detail cost bar say which one it is.
- **Run detail shows what was recorded** (activity-page): every span
  expands, not only tool spans — a cron or turn root used to be a status
  dot and a duration, which was strictly less than the trace it summarized.
  Expanding a span now shows its model and token usage, its list cost, its
  attributes, its recorded events, and (for tool spans) the input/output
  payload as before. The header carries origin, outcome, start, duration
  and the run's token totals; a failure reason renders in full.
- **No event type renders nowhere**: `narrativeEventsFor` picks up
  everything the tool-payload expander filters out — transcript excerpts,
  the cron wrapper's `job_output`, and any type a span-sink producer
  invents — and `eventTypeLabel` names it instead of mislabelling it as
  "Output".
- **Raw trace escape hatch**: the run detail can dump its spans, events and
  rollup as JSON, so the rendered view is never less than the record.
