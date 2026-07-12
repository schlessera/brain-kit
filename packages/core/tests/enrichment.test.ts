import { describe, expect, test } from "bun:test";

import type { CompletionProvider, ContentPart } from "../src/lib/seams";
import { createEnrichment } from "../src/lib/enrichment";

interface Recorder {
  calls: Array<{ system?: string; prompt: string; parts?: ContentPart[]; maxTokens?: number }>;
}

function mockProvider(
  opts: { vision: boolean; reply?: string },
  rec: Recorder
): CompletionProvider {
  return {
    id: "mock",
    capabilities: { vision: opts.vision },
    async complete(req) {
      rec.calls.push(req);
      return opts.reply ?? "";
    },
  };
}

describe("createEnrichment.describeAsset", () => {
  test("degrades to the title when the provider has no vision", async () => {
    const rec: Recorder = { calls: [] };
    const enrich = createEnrichment(mockProvider({ vision: false, reply: "should not run" }, rec));

    const out = await enrich.describeAsset(new Uint8Array([1, 2, 3]), "image/png", "My Diagram");

    expect(out).toBe("My Diagram");
    expect(rec.calls.length).toBe(0); // no completion call at all
  });

  test("passes the image part and returns the trimmed description", async () => {
    const rec: Recorder = { calls: [] };
    const enrich = createEnrichment(mockProvider({ vision: true, reply: "  A wiring diagram.  " }, rec));

    const out = await enrich.describeAsset(new Uint8Array([1]), "image/png", "Diagram");

    expect(out).toBe("A wiring diagram.");
    expect(rec.calls.length).toBe(1);
    expect(rec.calls[0].parts).toEqual([{ kind: "image", data: new Uint8Array([1]), mimeType: "image/png" }]);
    expect(rec.calls[0].prompt).toContain("Describe this image/document in 2-3 concise sentences");
    expect(rec.calls[0].prompt).toContain('titled "Diagram"');
  });

  test("routes application/pdf to a pdf part", async () => {
    const rec: Recorder = { calls: [] };
    const enrich = createEnrichment(mockProvider({ vision: true, reply: "A report." }, rec));

    await enrich.describeAsset(new Uint8Array([9]), "application/pdf", "Q3");

    expect(rec.calls[0].parts).toEqual([{ kind: "pdf", data: new Uint8Array([9]) }]);
  });

  test("falls back to the title when the model returns nothing", async () => {
    const rec: Recorder = { calls: [] };
    const enrich = createEnrichment(mockProvider({ vision: true, reply: "   " }, rec));

    const out = await enrich.describeAsset(new Uint8Array([1]), "image/png", "Fallback Title");

    expect(out).toBe("Fallback Title");
  });
});

describe("createEnrichment.generateChunkContext", () => {
  test("builds the contextual-retrieval prompt and truncates inputs", async () => {
    const rec: Recorder = { calls: [] };
    const enrich = createEnrichment(mockProvider({ vision: true, reply: "  Situating sentence.  " }, rec));

    const longDoc = "D".repeat(10000);
    const longChunk = "C".repeat(5000);
    const out = await enrich.generateChunkContext("Doc Title", longDoc, "Heading", longChunk);

    expect(out).toBe("Situating sentence.");
    const prompt = rec.calls[0].prompt;
    expect(prompt).toContain('<document title="Doc Title">');
    expect(prompt).toContain('<chunk heading="Heading">');
    expect(prompt).toContain("situating this chunk within the overall document");
    // Verbatim truncation: 8000 doc chars + 2000 chunk chars.
    expect(prompt).toContain("D".repeat(8000));
    expect(prompt).not.toContain("D".repeat(8001));
    expect(prompt).toContain("C".repeat(2000));
    expect(prompt).not.toContain("C".repeat(2001));
  });

  test("no parts are sent for a text-only chunk context", async () => {
    const rec: Recorder = { calls: [] };
    const enrich = createEnrichment(mockProvider({ vision: true, reply: "x" }, rec));

    await enrich.generateChunkContext("T", "doc", "h", "chunk");

    expect(rec.calls[0].parts).toBeUndefined();
  });
});
