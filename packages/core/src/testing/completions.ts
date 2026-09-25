/**
 * Published CompletionProvider contract suite — the executable form of the
 * promises in docs/extending/completions.md and on the interface in
 * ../lib/seams.ts:
 *
 *   1. `id` is a string and `capabilities.vision` a boolean
 *   2. `complete` resolves to the text the model answered
 *   3. `system` and `maxTokens` are accepted alongside the prompt
 *   4. `parts` are additive: text, image and PDF parts never make a request
 *      fail, whatever `capabilities.vision` says
 *   5. `capabilities.vision` is what core degrades against: with `false`, an
 *      asset description never sends the asset and falls back to its title;
 *      with `true`, the asset reaches `complete` as a part and the answer is
 *      the description
 *
 * Case 5 drives core's own enrichment (`createEnrichment`) over the provider,
 * so it checks the declared capability against what core does with it.
 * Providers run against caller-supplied fake runtimes, never a live model.
 */

import { createEnrichment } from "../lib/enrichment.js";
import type { CompletionProvider, ContentPart } from "../lib/seams.js";
import { PDF_1PAGE as PDF, PNG_1X1 as PIXEL } from "./fixtures.js";
import type { ContractTestPrimitives } from "./primitives.js";

export interface CompletionProviderContractHarness {
  name: string;
  /** A provider whose model answers every request with exactly `text`. */
  answering(text: string): CompletionProvider;
}

const ANSWER = "A lighthouse on a rocky headland at dusk.";

type CompleteRequest = Parameters<CompletionProvider["complete"]>[0];

/** The provider, with every request it was handed recorded. */
function recording(provider: CompletionProvider): {
  provider: CompletionProvider;
  requests: CompleteRequest[];
} {
  const requests: CompleteRequest[] = [];
  return {
    requests,
    provider: {
      id: provider.id,
      capabilities: provider.capabilities,
      complete(req) {
        requests.push(req);
        return provider.complete(req);
      },
    },
  };
}

const binaryKinds = (requests: CompleteRequest[]): string[] =>
  requests.flatMap((r) => (r.parts ?? []).map((p) => p.kind)).filter((k) => k !== "text");

/** Register the CompletionProvider contract suite for one provider harness. */
export function runCompletionProviderContract(
  harness: CompletionProviderContractHarness,
  primitives: ContractTestPrimitives
): void {
  const { describe, expect, test } = primitives;

  describe(`CompletionProvider contract: ${harness.name}`, () => {
    test("id is a string and capabilities.vision a boolean", () => {
      const provider = harness.answering(ANSWER);
      expect(typeof provider.id).toBe("string");
      expect(typeof provider.capabilities?.vision).toBe("boolean");
    });

    test("complete resolves to the model's answer", async () => {
      const provider = harness.answering(ANSWER);
      expect(await provider.complete({ prompt: "Describe the picture." })).toBe(ANSWER);
    });

    test("complete accepts a system prompt and a token cap", async () => {
      const provider = harness.answering(ANSWER);
      const text = await provider.complete({
        system: "Answer in one sentence.",
        prompt: "Describe the picture.",
        maxTokens: 64,
      });
      expect(text).toBe(ANSWER);
    });

    test("parts are additive: text, image and PDF parts never fail a request", async () => {
      const provider = harness.answering(ANSWER);
      const parts: ContentPart[] = [
        { kind: "text", text: "Some surrounding context." },
        { kind: "image", data: PIXEL, mimeType: "image/png" },
        { kind: "pdf", data: PDF },
      ];
      expect(await provider.complete({ prompt: "Describe these.", parts })).toBe(ANSWER);
    });

    test("capabilities.vision decides whether core sends an image or falls back to its title", async () => {
      const { provider, requests } = recording(harness.answering(ANSWER));
      const title = "Harbour at dusk";
      const description = await createEnrichment(provider).describeAsset(PIXEL, "image/png", title);

      if (provider.capabilities.vision) {
        expect(binaryKinds(requests)).toEqual(["image"]);
        expect(description).toBe(ANSWER);
      } else {
        expect(binaryKinds(requests)).toEqual([]);
        expect(description).toBe(title);
      }
    });

    test("capabilities.vision decides whether core sends a PDF or falls back to its title", async () => {
      const { provider, requests } = recording(harness.answering(ANSWER));
      const title = "Voyage itinerary";
      const description = await createEnrichment(provider).describeAsset(
        PDF,
        "application/pdf",
        title
      );

      if (provider.capabilities.vision) {
        expect(binaryKinds(requests)).toEqual(["pdf"]);
        expect(description).toBe(ANSWER);
      } else {
        expect(binaryKinds(requests)).toEqual([]);
        expect(description).toBe(title);
      }
    });
  });
}
