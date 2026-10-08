/** Prospective comparison, frozen before tuning; no executable provider admission. */
export const protocol = {
  issue: 847, version: 1, date: "2026-07-12", runtime: { bun: "1.4.2", sdk: "0.3.293", cli: "2.1.293" },
  models: { baseline: "claude-sonnet-5-5", hybrid: "jev-1.13.0", fallback: "claude-sonnet-5-5" },
  arms: ["installed-keyword-scoring", "installed-complete-agent-research", "choice-plus-installed-explanation"],
  repetitions: 3, stateSizes: [1, 32, 128], order: "deterministically rotate arms within case/repetition; separate fresh roots",
  inputs: "Identical complete posting, metadata, scoring config, criteria, identity and frozen fictional company packet. No external company research in any arm. Full shipped research-opportunity skill, linked skills and CLI retained for agent assessment/explanation.",
  labels: "Author provisional. Complementary independently collected Sonnet5.5 source/label/ranking-rubric approval is required; flag-only or scripted approval cannot admit a live window.",
  tuning: "All9 tuning rows only; freeze one confidence/selected-probability threshold before observing12 held-out rows. Null threshold means no accepted classifications and no hybrid comparison dispatch.",
  choiceScope: "Passage must-have and permanent-residence dealbreaker only. No Score transport. Ordinal autonomy annotations are review context, never measured preferences or probabilities.",
  arithmetic: "Installed keyword scoring unchanged. Salary normalization, guaranteed minimum, weights, title/literal location exclusions deterministic. Unknown salary cannot enter candidate ranking. Report literal-marker false exclusions separately from semantic misses.",
  grading: "Confusion per criterion including unclear; relocation met routed to candidate is a critical miss; missing/partial salary routed to candidate is a critical miss. Compare exact candidate membership and pairwise order on commonly admitted candidates; ties reported separately. Unknown calibration reports eligible answered/abstained counts, confidence and selected probability separately.",
  reviewEffort: "Record every clarification, source verification, correction, explanation/generation and human decision as raw timed events with actor/input/output; scripted paths are controls, not measured review savings.",
  receipts: "All physical requests/responses before decoding and native stdin/stdout/stderr. Every attempt/retry/fallback/generation, model identity, input/output/cache counts, unknown invoice as null, additional billed dollars, diagnostic API equivalence, elapsed and child drain. Native auto auxiliary paths require resolved full accounting under#1275.",
  metrics: "Per-arm p50/p95 latency, throughput,3-repetition ranges and all state-size/subgroup results; no cost saving claim against zero-call keyword scoring without measured tradeoffs.",
  decision: "GO requires zero hard arithmetic/exclusion overrides, zero held-out critical misses, complete native/physical accounting, independent review and a documented quality/review-effort benefit against complete current-agent path. Report all wrong/unknown cases. Missing results leave verdict unmeasured, not NO-GO. Any measured acceptable opt-in follow-up needs its own scoped issue and contract assessment.",
  dispatchAllowed: false, blockedBy: [1275], hold: "Claude subscription availability expected2026-10-09, unverified. No model call, credential read, semantic approval or adoption through this module.",
} as const;
