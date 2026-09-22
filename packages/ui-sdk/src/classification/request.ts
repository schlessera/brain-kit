/**
 * One classification pass over one assistant message (D42 §1, §3).
 *
 * `planClassification` turns the message's text parts into candidates and
 * one request — the candidates as the state, keyed by id, and every
 * candidate's questions in one map — or null when there is nothing to ask,
 * which must cost nothing. `applyClassification` turns the answers back
 * into the blocks the message carries, each anchored to its part and span.
 * `observeClassification` reads the same answers a second way: every
 * confidence that came back, next to the line it had to clear and what
 * became of its candidate, which is what a threshold can be tuned on.
 *
 * The transport is the server's: this module knows the request and answer
 * shapes and nothing about keys, timeouts, or retries.
 */

import type { MessageBlock } from "../protocol.js";
import {
  questionsFor,
  thresholdFor,
  transformCandidate,
  type ClassificationAnswers,
  type ClassificationQuestion,
} from "./catalogue.js";
import { detectCandidates, type Candidate, type CandidateKind } from "./detect.js";

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

/**
 * One question's answer as it came back, with the line it had to clear and
 * what became of the candidate it was asked about. The confidence is the
 * figure a threshold is tuned on: a `choice`'s confidence, or the `noul`
 * itself, which is what the transforms compare.
 */
export interface QuestionObservation {
  /** The candidate the question was asked about, `p0c0`. */
  candidateId: string;
  candidateKind: CandidateKind;
  /** The question's suffix under that id: `shape`, `tone`, `criteria_first`, … */
  question: string;
  answerType: "choice" | "noul";
  /** The option chosen, for a `choice`; absent for a `noul`. */
  choice?: string;
  /** 0-1, as the transform reads it. */
  confidence: number;
  /** The line it had to clear, or null for a question the catalogue does not gate. */
  threshold: number | null;
  /** Whether the confidence cleared that line. */
  cleared: boolean;
  /** What became of the candidate: the block was drawn, or the markdown stayed. */
  outcome: "swapped" | "kept";
}

/**
 * Every answer this plan asked for, with its confidence. `blocks` is what
 * `applyClassification` returned for the same plan and answers — that is how
 * a question learns whether its candidate was swapped or kept, without
 * running a transform twice.
 *
 * The plan's OWN questions are the list walked, never the answer map: an
 * answer the plan did not ask for is a question the surface has no threshold
 * for and no transform reading it, and recording it would put a number in the
 * distribution that nothing was ever compared against. Unanswered questions
 * are simply absent.
 *
 * Pure, and cheap enough to run after every answered pass: one walk of the
 * questions, no strings built, nothing re-parsed.
 */
export function observeClassification(
  plan: ClassificationPlan,
  answers: ClassificationAnswers,
  blocks: readonly MessageBlock[]
): QuestionObservation[] {
  const drawn = new Set(blocks.map((block) => `${block.partIndex}:${block.start}:${block.end}`));
  // The asked question ids, grouped by the candidate they name, in the order
  // the catalogue asks them.
  const asked = new Map<string, string[]>();
  for (const id of Object.keys(plan.request.questions)) {
    const candidateId = id.slice(0, id.lastIndexOf("."));
    const ids = asked.get(candidateId);
    if (ids) ids.push(id);
    else asked.set(candidateId, [id]);
  }
  const out: QuestionObservation[] = [];
  for (const { partIndex, candidate } of plan.candidates) {
    const outcome = drawn.has(`${partIndex}:${candidate.start}:${candidate.end}`) ? "swapped" : "kept";
    const prefix = `${candidate.id}.`;
    for (const id of asked.get(candidate.id) ?? []) {
      const answer = answers[id];
      if (!answer) continue;
      const threshold = thresholdFor(id);
      const confidence = answer.type === "choice" ? answer.confidence : answer.noul;
      out.push({
        candidateId: candidate.id,
        candidateKind: candidate.kind,
        question: id.slice(prefix.length),
        answerType: answer.type,
        ...(answer.type === "choice" ? { choice: answer.choice } : {}),
        confidence,
        threshold: threshold ?? null,
        cleared: threshold !== undefined && confidence >= threshold,
        outcome,
      });
    }
  }
  return out;
}
