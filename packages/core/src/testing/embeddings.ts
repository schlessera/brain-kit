/**
 * Published EmbeddingProvider contract suite — the executable form of the
 * promises in docs/extending/embeddings.md and on the interface in
 * ../lib/seams.ts:
 *
 *   1. `id` is a non-empty string and `dimensions` a positive integer
 *   2. `embed` returns one `Float32Array` per text, each `dimensions` wide —
 *      the indexer refuses a vector of any other width
 *   3. `embedQuery` returns one such vector, called with or without `opts`
 *      (a one-argument `embedQuery` stays compatible)
 *   4. `embedQuery` honours or tolerates `opts.signal`: an already-aborted
 *      signal either rejects or still yields a valid vector, and never hangs;
 *      a provider that forwards the signal rejects once it aborts mid-request
 *   5. `embedImage` / `embedPdf` are methods or absent; present, each returns
 *      a `dimensions`-wide vector; absent, core embeds the text description
 *      through `embed` instead, which must then yield one
 *
 * Providers run against caller-supplied fake runtimes (an isolated `fetch`,
 * a local stub), never a live vendor and never a key.
 */

import type { EmbeddingProvider } from "../lib/seams.js";
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

/** How long a responsive fake runtime may take before a call counts as hung. */
const SETTLE_MS = 5_000;

const PIXEL = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");

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
    test("id is a non-empty string and dimensions a positive integer", () => {
      const provider = harness.provider();
      expect(typeof provider.id).toBe("string");
      expect(provider.id.length).toBeGreaterThan(0);
      expect(Number.isInteger(provider.dimensions)).toBe(true);
      expect(provider.dimensions).toBeGreaterThan(0);
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
      test("a forwarded signal rejects the pending embedQuery once it aborts", async () => {
        const provider = harness.hanging!();
        const controller = new AbortController();
        const query = provider.embedQuery("a search query", { signal: controller.signal });
        // Let the request reach the runtime before cancelling it.
        await new Promise((r) => setTimeout(r, 20));
        controller.abort(new Error("search deadline"));

        const outcome = await settleWithin(query, SETTLE_MS);
        expect(outcome.state).toBe("rejected");
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
        ? await provider.embedImage(PIXEL, "image/png", description)
        : (await provider.embed([description]))[0];
      expect(shape(vector)).toEqual({ float32: true, width: provider.dimensions });
    });

    test("a PDF embeds to a dimensions-wide vector, from its bytes or its description", async () => {
      const provider = harness.provider();
      const description = "A one-page itinerary for a sea voyage.";
      const vector = provider.embedPdf
        ? await provider.embedPdf(PDF, description)
        : (await provider.embed([description]))[0];
      expect(shape(vector)).toEqual({ float32: true, width: provider.dimensions });
    });
  });
}
