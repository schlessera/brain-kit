/**
 * One classification pass over one assistant message (D42 §1, §3).
 *
 * `planClassification` turns the message's text parts into candidates and
 * one request — the candidates as the state, keyed by id, and every
 * candidate's questions in one map — or null when there is nothing to ask,
 * which must cost nothing. `applyClassification` turns the answers back
 * into the blocks the message carries, each anchored to its part and span.
 *
 * The transport is the server's: this module knows the request and answer
 * shapes and nothing about keys, timeouts, or retries.
 */

import type { MessageBlock } from "../protocol.js";
import {
  questionsFor,
  transformCandidate,
  type ClassificationAnswers,
  type ClassificationQuestion,
} from "./catalogue.js";
import { detectCandidates, type Candidate } from "./detect.js";

/** The classifier's model alias. Pinned here so a bump is one line. */
export const CLASSIFIER_MODEL = "jev-latest";

/** The request body, in the classifier's own shape. */
export interface ClassificationRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, ClassificationQuestion>;
}

/** A candidate with the part it came from, so an answer can be anchored. */
export interface PlannedCandidate {
  partIndex: number;
  candidate: Candidate;
}

export interface ClassificationPlan {
  request: ClassificationRequest;
  candidates: PlannedCandidate[];
}

/** Only what the classifier needs of a candidate: never the whole answer. */
function stateOf(candidate: Candidate): Record<string, unknown> {
  switch (candidate.kind) {
    case "table":
      return { kind: "table", headers: candidate.headers, rows: candidate.rows };
    case "ordered_list":
      return { kind: "numbered list", items: candidate.items };
    case "timed_list":
      return { kind: "list with times", items: candidate.items };
    case "blockquote":
      return {
        kind: "quoted passage",
        text: candidate.text,
        ...(candidate.source ? { source: candidate.source } : {}),
      };
    case "kv_run":
      return { kind: "key and value lines", rows: candidate.rows };
  }
}

/**
 * Plan the pass for a message's text parts, in order. Candidate ids are
 * made unique across parts (`p0c1`), because one request carries them all.
 */
export function planClassification(textParts: readonly string[]): ClassificationPlan | null {
  const candidates: PlannedCandidate[] = [];
  const state: Record<string, unknown> = {};
  const questions: Record<string, ClassificationQuestion> = {};
  textParts.forEach((text, partIndex) => {
    for (const found of detectCandidates(text)) {
      const candidate: Candidate = { ...found, id: `p${partIndex}${found.id}` };
      candidates.push({ partIndex, candidate });
      state[candidate.id] = stateOf(candidate);
      Object.assign(questions, questionsFor(candidate));
    }
  });
  if (candidates.length === 0) return null;
  return { request: { model: CLASSIFIER_MODEL, state, questions }, candidates };
}

/** The blocks the answers yield, anchored; candidates the answers leave alone are absent. */
export function applyClassification(
  plan: ClassificationPlan,
  answers: ClassificationAnswers
): MessageBlock[] {
  const out: MessageBlock[] = [];
  for (const { partIndex, candidate } of plan.candidates) {
    const classified = transformCandidate(candidate, answers);
    if (!classified) continue;
    out.push({
      partIndex,
      start: candidate.start,
      end: candidate.end,
      block: classified.block,
      confidence: classified.confidence,
    });
  }
  return out;
}
