import { describe, expect, test } from "bun:test";

import type { CompletionProvider, ContentPart } from "../src/lib/seams";
import { CONTEXT_DOCUMENT_BUDGET, createEnrichment } from "../src/lib/enrichment";

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
    // The document half stays within its 8,000-character budget; the chunk
    // half is truncated to 2,000 characters.
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

/** The document half of a recorded chunk-context prompt. */
function documentPart(prompt: string): string {
  const match = prompt.match(/^<document title="[^"]*">\n([\s\S]*)\n<\/document>\n\n<chunk /);
  if (!match) throw new Error("no document part in the prompt");
  return match[1];
}

/**
 * A 30,000-character document: 17 sections, each a `##` heading with a `###`
 * subheading and two paragraphs of about 950 characters that name themselves.
 */
function longDocument(): { text: string; headings: string[]; paragraph: (n: number, part: "a" | "b") => string } {
  const paragraph = (n: number, part: "a" | "b") =>
    `Paragraph ${n}${part} about airship route ${n}. ` + `Mooring mast log entry ${n}${part}. `.repeat(30).trim();
  const headings: string[] = [];
  const blocks: string[] = [];
  for (let n = 1; n <= 17; n++) {
    headings.push(`## Route ${n}`, `### Crossing ${n}`);
    blocks.push(`## Route ${n}`, "", paragraph(n, "a"), "", `### Crossing ${n}`, "", paragraph(n, "b"), "");
  }
  return { text: blocks.join("\n"), headings, paragraph };
}

describe("the chunk-context prompt for a long document (#427)", () => {
  test("a chunk far past the budget is sent with its preceding paragraph and the whole outline", async () => {
    const doc = longDocument();
    expect(doc.text.length).toBeGreaterThan(29_000);
    // The section that holds offset 25,000.
    const n = [...Array(17).keys()].map((i) => i + 1).find((i) => doc.text.indexOf(doc.paragraph(i, "b")) >= 25_000)!;
    const chunk = doc.paragraph(n, "b");
    expect(doc.text.indexOf(chunk)).toBeGreaterThanOrEqual(25_000);

    const rec: Recorder = { calls: [] };
    const enrich = createEnrichment(mockProvider({ vision: false, reply: "x" }, rec));
    await enrich.generateChunkContext("Airship routes", doc.text, `Crossing ${n}`, chunk, "Every route the fleet flies.");

    const document = documentPart(rec.calls[0].prompt);
    expect(document).toContain(doc.paragraph(n, "a"));
    expect(document).toContain(`Outline:\n${doc.headings.join("\n")}\n\n`); // every heading, in order
    expect(document).toContain("Summary: Every route the fleet flies.");
    expect(document.length).toBeLessThanOrEqual(CONTEXT_DOCUMENT_BUDGET);
  });

  test("a document within the budget produces today's prompt, byte for byte", async () => {
    const text = "## Only\n\nA short note about a mooring mast.";
    const rec: Recorder = { calls: [] };
    const enrich = createEnrichment(mockProvider({ vision: false, reply: "x" }, rec));
    await enrich.generateChunkContext("Short", text, "Only", "A short note about a mooring mast.", "A summary it ignores");

    expect(rec.calls[0].prompt).toBe(
      `<document title="Short">\n${text}\n</document>\n\n` +
        `<chunk heading="Only">\nA short note about a mooring mast.\n</chunk>\n\n` +
        `Write 1-2 short sentences situating this chunk within the overall document, ` +
        `to improve search retrieval of the chunk. Mention the document's subject and ` +
        `what this chunk covers. Answer with only the context sentences, nothing else.`
    );
  });

  test("the document half never exceeds the budget, wherever the chunk sits", async () => {
    const doc = longDocument();
    // Many headings and a long summary, so the outline and summary are clipped.
    const crowded = Array.from({ length: 400 }, (_, i) => `## Heading number ${i}`).join("\n") + "\n" + doc.text;
    const rec: Recorder = { calls: [] };
    const enrich = createEnrichment(mockProvider({ vision: false, reply: "x" }, rec));
    const chunks = [doc.paragraph(1, "a"), doc.paragraph(8, "b"), doc.paragraph(17, "b"), "text that is nowhere in it"];
    for (const text of [doc.text, crowded]) {
      for (const chunk of chunks) {
        await enrich.generateChunkContext("Airship routes", text, "Crossing 8", chunk, "S".repeat(5000));
      }
    }
    expect(rec.calls.length).toBe(8);
    for (const call of rec.calls) {
      const document = documentPart(call.prompt);
      expect(document.length).toBeLessThanOrEqual(CONTEXT_DOCUMENT_BUDGET);
      expect(document.length).toBeGreaterThan(CONTEXT_DOCUMENT_BUDGET - 200);
    }
  });
});
