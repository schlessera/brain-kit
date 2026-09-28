/**
 * Published Reranker contract suite — the executable form of the promises in
 * docs/extending/rerankers.md and on the interface in ../lib/seams.ts:
 *
 *   1. `id` is a string; `capabilities.modes` lists lanes from fts, vector,
 *      hybrid; `capabilities.network` is a boolean
 *   2. `rerank` returns every candidate exactly once, as the caller's own
 *      object (by reference), each with a finite score — the identity is
 *      `source` + `id`, so the same `id` from two sources stays two candidates
 *   3. a single candidate, and an empty list, come back unchanged in length
 *   4. `preview`, when present, returns a value and sends nothing
 *   5. `rerank` honours or tolerates `signal`: an already-aborted signal
 *      either rejects or still returns a permutation, and never hangs; a
 *      reranker that forwards the signal rejects promptly once it aborts
 *
 * Rerankers run against caller-supplied fake runtimes (an isolated `fetch`,
 * a local stub), never a live vendor and never a key.
 */

import type { Ranked, RerankCandidate, Reranker } from "../lib/seams.js";
import { settleWithin, type ContractTestPrimitives } from "./primitives.js";

export interface RerankerContractHarness {
  name: string;
  /** A reranker whose runtime answers every request as the vendor would. */
  reranker(): Reranker;
  /**
   * A reranker whose runtime never answers until the request is cancelled.
   * Supply it when the reranker forwards `signal`; omit it for one that
   * ignores cancellation — search bounds those with its own deadline.
   */
  hanging?(): Reranker;
  /**
   * Requests that reached the network since the harness last reset it. When
   * supplied, the suite asserts `preview` sends nothing.
   */
  sent?(): number;
}

const SETTLE_MS = 2_000;
const REJECT_WITHIN_MS = 400;

function pool(): RerankCandidate[] {
  return [
    { id: "notes/harbour.md", source: "brain", title: "Harbour map", type: "note", tags: "sea, map", summary: "A hand-drawn map of the harbour", excerpt: "the harbour at dawn" },
    { id: "notes/voyage.md", source: "brain", title: "Voyage itinerary", type: "travel", tags: "sea", summary: "Where the ship stops", excerpt: "day three: the island" },
    { id: "rec-42", source: "other", title: "Harbour master contact", summary: null, excerpt: "call before docking" },
    { id: "notes/harbour.md", source: "other", title: "Harbour map (copy)", excerpt: "same path, another source" },
  ];
}

function describeOrder(input: readonly RerankCandidate[], output: readonly Ranked[]): string[] {
  const problems: string[] = [];
  if (output.length !== input.length) problems.push(`returned ${output.length} of ${input.length}`);
  const seen = new Set<RerankCandidate>();
  for (const { item, score } of output) {
    if (!input.includes(item)) problems.push(`not the caller's object: ${item?.source}:${item?.id}`);
    if (seen.has(item)) problems.push(`duplicate: ${item.source}:${item.id}`);
    if (typeof score !== "number" || !Number.isFinite(score)) problems.push(`non-finite score for ${item?.id}`);
    seen.add(item);
  }
  return problems;
}

/** Register the Reranker contract suite for one reranker harness. */
export function runRerankerContract(harness: RerankerContractHarness, primitives: ContractTestPrimitives): void {
  const { describe, expect, test } = primitives;

  describe(`Reranker contract: ${harness.name}`, () => {
    test("id, modes and network are declared", () => {
      const r = harness.reranker();
      expect(typeof r.id).toBe("string");
      expect(Array.isArray(r.capabilities.modes)).toBe(true);
      expect(r.capabilities.modes.every((m) => m === "fts" || m === "vector" || m === "hybrid")).toBe(true);
      expect(typeof r.capabilities.network).toBe("boolean");
    });

    test("rerank returns every candidate once, by reference, with a finite score", async () => {
      const input = pool();
      const output = await harness.reranker().rerank({ query: "harbour map", candidates: input, mode: "hybrid" });
      expect(describeOrder(input, output)).toEqual([]);
    });

    test("a single candidate and an empty list keep their length", async () => {
      const r = harness.reranker();
      const one = pool().slice(0, 1);
      expect(describeOrder(one, await r.rerank({ query: "harbour", candidates: one }))).toEqual([]);
      expect((await r.rerank({ query: "harbour", candidates: [] })).length).toBe(0);
    });

    test("preview, when present, returns a value and sends nothing", () => {
      const r = harness.reranker();
      if (!r.preview) return;
      const before = harness.sent?.() ?? 0;
      const preview = r.preview({ query: "harbour", candidates: pool() });
      expect(preview === undefined ? "undefined" : "value").toBe("value");
      expect(harness.sent?.() ?? 0).toBe(before);
    });

    test("an already-aborted signal rejects or still returns a permutation, and settles", async () => {
      const controller = new AbortController();
      controller.abort(new Error("deadline passed before the call"));
      const input = pool();
      const outcome = await settleWithin(
        harness.reranker().rerank({ query: "harbour", candidates: input, signal: controller.signal }),
        SETTLE_MS
      );
      expect(outcome.state === "pending" ? "hung" : "settled").toBe("settled");
      if (outcome.state === "resolved") expect(describeOrder(input, outcome.value)).toEqual([]);
    });

    if (harness.hanging) {
      test("a forwarded signal rejects the pending rerank promptly", async () => {
        const controller = new AbortController();
        const call = harness.hanging!().rerank({ query: "harbour", candidates: pool(), signal: controller.signal });
        expect((await settleWithin(call, 300)).state).toBe("pending");
        controller.abort(new Error("search deadline"));
        expect((await settleWithin(call, REJECT_WITHIN_MS)).state).toBe("rejected");
      });
    }
  });
}
