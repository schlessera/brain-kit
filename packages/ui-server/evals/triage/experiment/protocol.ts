/**
 * The experiment's fixed parameters, written down before any measurement so a
 * result cannot move them. Change one and the README's go/no-go changes with it.
 */
import { JEV_TIMEOUT_MS } from "../../../src/classification/jev-client";

export const protocol = Object.freeze({
  issue: 848,
  models: {
    /** Pinned by the maintainer ruling on #838 (2026-10-07). */
    classification: "jev-1.13.0",
    /** The generative arm the donor runner scores on the same corpus. */
    baseline: "claude-sonnet-5-5",
  },
  shapes: ["choice", "ordered-noul"] as const,
  batching: [1, 8] as const,
  repetitions: 3,
  /**
   * Conservative UTF-8 byte ceilings standing in for the documented token
   * bounds: #680's 4k per item / 40k per batch, and the model page's 32k for
   * state plus the longest question. A byte over-counts a token, so an
   * admitted request is inside the budget; it is not a tokenizer measurement.
   */
  bounds: { itemBytes: 4000, requestBytes: 40000, statePlusLongestQuestionBytes: 32000 },
  /** The shipped client's whole-call budget, retry included. */
  responseDeadlineMs: JEV_TIMEOUT_MS,
  /**
   * Provisional acceptance floors. A Choice is accepted when both its
   * confidence and the selected route's probability clear `choice`; a Noul
   * counts as true at or above `noulTrue`, false at or below `noulFalse`, and
   * is otherwise abstained. Tune on the tuning split only; freeze before the
   * held-out split is scored.
   */
  thresholds: { choice: 0.8, noulTrue: 0.8, noulFalse: 0.2 },
  /** List rate read from https://docs.typesafe.ai/models on 2026-10-08. Not an invoice. */
  pricing: { inputUsdPerMTok: 0.042, outputUsdPerMTok: 0 },
  /** Actual additional charge caps from the standing authorization on #838. */
  capsUsd: { issue: 15, aggregate: 150 },
});
