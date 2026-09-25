import { describe, expect, test } from "bun:test";

import type { CompletionProvider, ContentPart } from "../src/lib/seams";
import {
  CONTEXT_DOCUMENT_BUDGET,
  OUTLINE_BUDGET,
  createEnrichment,
  documentForChunk,
  locateChunk,
  outlineOf,
} from "../src/lib/enrichment";

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
    // No summary, no headings, a chunk that is not in the document: the
    // document half is the budget's worth of the document from its start.
    // The chunk half is truncated to 2,000 characters.
    const label = "Excerpt around the chunk:\n";
    expect(documentPart(prompt)).toBe(label + "D".repeat(CONTEXT_DOCUMENT_BUDGET - label.length));
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

describe("locating the chunk, the outline's overflow, and clipping (#427 review)", () => {
  const filler = (tag: string, n: number) => `${tag} filler sentence. `.repeat(n).trim();
  const boilerplate = "Standard mooring checklist: mast secured, ballast trimmed, gas cells checked, crew briefed. ".repeat(3);

  test("a chunk whose full text is unique is found even when its opening is repeated boilerplate", () => {
    const sections = Array.from({ length: 10 }, (_, i) => [
      `## Log ${i}`,
      "",
      `Before log ${i}: ${filler(`pre${i}`, 20)}`,
      "",
      `${boilerplate}Entry ${i}: ${filler(`entry${i}`, 20)}`,
      "",
    ]).flat();
    const doc = sections.join("\n");
    expect(doc.length).toBeGreaterThan(CONTEXT_DOCUMENT_BUDGET);
    const chunk = `${boilerplate}Entry 8: ${filler("entry8", 20)}`;
    expect(locateChunk(doc, chunk, "Log 8")).toBe(doc.indexOf(chunk));

    const document = documentForChunk(doc, chunk, "Log 8");
    expect(document).toContain(`Before log 8: ${filler("pre8", 20)}`);
    expect(document).not.toContain("Before log 1:");
  });

  test("a repeated prefix is resolved by the chunk's heading, and left unresolved when the heading repeats too", () => {
    // Not periodic, so the 200-character prefix matches once per section.
    const opening = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ") + " shared opening. ";
    expect(opening.length).toBeGreaterThan(200);
    const doc = [
      "## Alpha", "", `${opening}alpha body`, "",
      "## Beta", "", `${opening}beta body`, "",
      "## Beta", "", `${opening}second beta body`, "",
    ].join("\n");
    // The chunk text as the chunker might have reshaped it: not verbatim in
    // the document, so only its prefix matches, in all three sections.
    const reshaped = `${opening}alpha body, merged with more text`;
    expect(locateChunk(doc, reshaped, "Alpha")).toBe(doc.indexOf(`${opening}alpha body`));
    // Two sections carry the heading "Beta": neither the prefix nor the heading line decides.
    expect(locateChunk(doc, `${opening}beta, reshaped`, "Beta")).toBe(-1);
  });

  test("empty input locates nothing and still fits the budget", () => {
    const doc = filler("empty", 800);
    expect(doc.length).toBeGreaterThan(CONTEXT_DOCUMENT_BUDGET);
    expect(locateChunk(doc, "", "(intro)")).toBe(-1);
    expect(locateChunk("", "text", "Heading")).toBe(-1);
    const document = documentForChunk(doc, "", "(intro)", "");
    expect(document.startsWith(`Excerpt around the chunk:\n${doc.slice(0, 100)}`)).toBe(true);
    expect(document.length).toBeLessThanOrEqual(CONTEXT_DOCUMENT_BUDGET);
    expect(documentForChunk("", "", "(intro)")).toBe("");
  });

  test("an outline over 1,800 characters that fits the outline budget is sent whole", () => {
    const headings = Array.from({ length: 120 }, (_, i) => `## Topic ${String(i).padStart(3, "0")} ${"t".repeat(12)}`);
    const outline = headings.join("\n");
    expect(outline.length).toBeGreaterThan(1800);
    expect(outline.length).toBeLessThanOrEqual(OUTLINE_BUDGET);
    const doc = headings.map((h) => `${h}\n\n${filler("body", 3)}\n`).join("\n") + `\n${filler("tail", 800)}`;
    const document = documentForChunk(doc, filler("tail", 800).slice(-300), "Topic 119 tttttttttttt");
    expect(document).toContain(`Outline:\n${outline}\n\n`);
    expect(document.length).toBeLessThanOrEqual(CONTEXT_DOCUMENT_BUDGET);
  });

  test("an outline over its budget drops ### headings first, then elides the middle ## headings with a count", () => {
    const sections = Array.from({ length: 100 }, (_, i) => `## Section ${i}`);
    const withSubs = sections.flatMap((h, i) => [h, `### Sub ${i} ${"s".repeat(30)}`]).join("\n");
    expect(withSubs.length).toBeGreaterThan(OUTLINE_BUDGET);
    expect(outlineOf(withSubs)).toBe(sections.join("\n"));

    const many = Array.from({ length: 400 }, (_, i) => `## Heading number ${i}`);
    const elided = outlineOf(many.join("\n"));
    expect(elided.length).toBeLessThanOrEqual(OUTLINE_BUDGET);
    const lines = elided.split("\n");
    expect(lines[0]).toBe("## Heading number 0");
    expect(lines.at(-1)).toBe("## Heading number 399");
    const marker = lines.find((line) => line.startsWith("… "))!;
    const omitted = Number(marker.match(/^… (\d+) more headings …$/)![1]);
    expect(lines.length - 1 + omitted).toBe(400); // every heading is shown or counted
  });

  test("no clip point splits a surrogate pair", () => {
    // Every character is an emoji after one ASCII one, so an odd clip point
    // lands inside a pair wherever the window falls.
    const doc = "x" + "\u{1F600}".repeat(6000);
    const summaries = [null, "a".repeat(599) + "\u{1F600}tail", "b".repeat(598) + "\u{1F600}tail"];
    const rec: Recorder = { calls: [] };
    const enrich = createEnrichment(mockProvider({ vision: false, reply: "x" }, rec));
    const run = async () => {
      for (const summary of summaries) {
        for (const at of [1, 2, 3, 4001, 4002, 9001, 9002, 11999]) {
          await enrich.generateChunkContext("Faces", doc, "(intro)", doc.slice(at, at + 40), summary);
        }
      }
    };
    return run().then(() => {
      expect(rec.calls.length).toBe(24);
      const malformed = rec.calls.filter((call) => !documentPart(call.prompt).isWellFormed());
      expect(malformed.length).toBe(0);
    });
  });
});
