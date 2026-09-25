/**
 * Published EmbeddingProvider contract suite — the executable form of the
 * promises in docs/extending/embeddings.md and on the interface in
 * ../lib/seams.ts:
 *
 *   1. `id` is a string and `dimensions` a number
 *   2. `embed` returns one `Float32Array` per text, each `dimensions` wide —
 *      the indexer refuses a vector of any other width
 *   3. `embedQuery` returns one such vector, called with or without `opts`
 *      (a one-argument `embedQuery` stays compatible)
 *   4. `embedQuery` honours or tolerates `opts.signal`: an already-aborted
 *      signal either rejects or still yields a valid vector, and never hangs;
 *      a provider that forwards the signal keeps waiting on its runtime while
 *      the signal stays live, and rejects promptly once it aborts, whenever
 *      that is
 *   5. `embedImage` / `embedPdf` are methods or absent; present, each returns
 *      a `dimensions`-wide vector; absent, core embeds the text description
 *      through `embed` instead, which must then yield one
 *
 * Providers run against caller-supplied fake runtimes (an isolated `fetch`,
 * a local stub), never a live vendor and never a key.
 */

import type { EmbeddingProvider } from "../lib/seams.js";
import { PDF_1PAGE, PNG_1X1 } from "./fixtures.js";
import { settleWithin, type ContractTestPrimitives } from "./primitives.js";

export interface EmbeddingProviderContractHarness {
  name: string;
  /**
   * A provider whose runtime answers every request as the vendor would,
   * honouring the requested output width.
   */
  provider(): EmbeddingProvider;
  /**
   * A provider whose runtime never answers a query until the request is
   * cancelled. Supply it when the provider forwards `opts.signal`; the suite
   * then asserts that aborting rejects the pending `embedQuery`. Omit it for a
   * provider that ignores cancellation — search bounds those itself.
   */
  hanging?(): EmbeddingProvider;
}

/**
 * How long a responsive fake runtime may take before a call counts as hung.
 * Under bun:test's default 5s per-test timeout; run the suite with
 * `--timeout 30000` all the same, as this repository does.
 */
const SETTLE_MS = 2_000;
/** How long a query whose signal never aborts must stay pending. */
const UNCANCELLED_MS = 1_000;
/** When the suite aborts a pending query: once early, once late. */
const ABORT_AFTER_MS = [50, 700] as const;
/**
 * How soon after its abort a query must reject. Each abort's window ends
 * before the next opens, and the late one opens after UNCANCELLED_MS, so a
 * query that rejects on a clock of its own misses at least one of them.
 */
const REJECT_WITHIN_MS = 400;

/** What a vector looks like, in a shape `toEqual` can compare legibly. */
function shape(vector: unknown): { float32: boolean; width: number | null } {
  return {
    float32: vector instanceof Float32Array,
    width: vector instanceof Float32Array ? vector.length : null,
  };
}

/** Register the EmbeddingProvider contract suite for one provider harness. */
export function runEmbeddingProviderContract(
  harness: EmbeddingProviderContractHarness,
  primitives: ContractTestPrimitives
): void {
  const { describe, expect, test } = primitives;

  describe(`EmbeddingProvider contract: ${harness.name}`, () => {
    test("id is a string and dimensions a number", () => {
      const provider = harness.provider();
      expect(typeof provider.id).toBe("string");
      expect(typeof provider.dimensions).toBe("number");
    });

    test("embed returns one dimensions-wide vector per text", async () => {
      const provider = harness.provider();
      const texts = ["first document", "second document", "third document"];
      const vectors = await provider.embed(texts);

      expect(Array.isArray(vectors)).toBe(true);
      expect(vectors.length).toBe(texts.length);
      const want = { float32: true, width: provider.dimensions };
      expect(vectors.map(shape)).toEqual(texts.map(() => want));
    });

    test("embedQuery returns one dimensions-wide vector, with or without opts", async () => {
      const provider = harness.provider();
      const want = { float32: true, width: provider.dimensions };

      expect(shape(await provider.embedQuery("a search query"))).toEqual(want);
      const live = new AbortController().signal;
      expect(shape(await provider.embedQuery("a search query", { signal: live }))).toEqual(want);
    });

    test("embedQuery tolerates an already-aborted signal: it rejects or yields a vector, and settles", async () => {
      const provider = harness.provider();
      const controller = new AbortController();
      controller.abort(new Error("cancelled before the query started"));

      const outcome = await settleWithin(
        provider.embedQuery("a search query", { signal: controller.signal }),
        SETTLE_MS
      );
      expect(outcome.state === "pending" ? "hung" : "settled").toBe("settled");
      if (outcome.state === "resolved") {
        expect(shape(outcome.value)).toEqual({ float32: true, width: provider.dimensions });
      }
    });

    if (harness.hanging) {
      test("a query whose signal stays live keeps waiting on its runtime", async () => {
        const provider = harness.hanging!();
        const controller = new AbortController();
        const query = provider.embedQuery("a search query", { signal: controller.signal });
        // Rejecting without an abort is a failure of its own, not cancellation.
        expect((await settleWithin(query, UNCANCELLED_MS)).state).toBe("pending");
        // Not awaited: whether the abort is honoured is the next case's question.
        query.catch(() => {});
        controller.abort(new Error("test over"));
      });

      test("a forwarded signal rejects the pending embedQuery promptly, early or late", async () => {
        const outcomes: string[] = [];
        for (const after of ABORT_AFTER_MS) {
          const provider = harness.hanging!();
          const controller = new AbortController();
          const query = provider.embedQuery("a search query", { signal: controller.signal });
          const before = await settleWithin(query, after);
          controller.abort(new Error("search deadline"));
          const outcome = before.state === "pending" ? await settleWithin(query, REJECT_WITHIN_MS) : before;
          outcomes.push(`abort at ${after}ms: ${outcome.state}`);
        }
        expect(outcomes).toEqual(ABORT_AFTER_MS.map((after) => `abort at ${after}ms: rejected`));
      });
    }

    test("embedImage and embedPdf are methods or absent", () => {
      const provider = harness.provider();
      for (const method of ["embedImage", "embedPdf"] as const) {
        const kind = typeof provider[method];
        expect(`${method}: ${kind === "function" || kind === "undefined" ? "ok" : kind}`).toBe(
          `${method}: ok`
        );
      }
    });

    test("an image embeds to a dimensions-wide vector, from its bytes or its description", async () => {
      const provider = harness.provider();
      const description = "A hand-drawn map of a small harbour.";
      const vector = provider.embedImage
        ? await provider.embedImage(PNG_1X1, "image/png", description)
        : (await provider.embed([description]))[0];
      expect(shape(vector)).toEqual({ float32: true, width: provider.dimensions });
    });

    test("a PDF embeds to a dimensions-wide vector, from its bytes or its description", async () => {
      const provider = harness.provider();
      const description = "A one-page itinerary for a sea voyage.";
      const vector = provider.embedPdf
        ? await provider.embedPdf(PDF_1PAGE, description)
        : (await provider.embed([description]))[0];
      expect(shape(vector)).toEqual({ float32: true, width: provider.dimensions });
    });
  });
}
