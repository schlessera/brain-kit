import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptQualifiers, TranscriptSymbols } from "../src/conversation/TranscriptQualifiers.js";

test("server rendering keeps unknown evidence honest without browser APIs or expanded technical content", () => {
  const html = renderToStaticMarkup(<TranscriptQualifiers kind="generated" restored evidenceLabel="Technical evidence (generated reply)"><pre>Technical fixture evidence</pre></TranscriptQualifiers>);
  expect(html).toContain("Voice reply; source unknown; playback unknown; restored. Transcript details.");
  expect(html).not.toContain("Technical fixture evidence");
  expect(html).not.toContain('aria-live');
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain('aria-hidden="true"');
  // One glyph per qualifier: the reply, its unknown playback and the restore.
  const glyphs = [...html.matchAll(/class="lucide (lucide-[a-z-]+)"/g)].map((m) => m[1]);
  expect(glyphs, "one glyph per qualifier").toEqual(["lucide-sparkles", "lucide-circle-dashed", "lucide-history"]);
});

test("server-rendered legend remains a discoverable native action without copying all evidence into transcript", () => {
  const html = renderToStaticMarkup(<TranscriptSymbols />);
  expect(html).toContain('type="button"');
  expect(html).toContain("Transcript symbols");
  expect(html).not.toContain("Received audio chunks played");
});


test("unsaved evidence uses the shared single-focus qualifier independently of playback",()=>{
 const html=renderToStaticMarkup(<TranscriptQualifiers kind="generated" source="Gemini Live" playback="unknown" unsaved evidenceLabel="Technical evidence"><p>Collapsed evidence</p></TranscriptQualifiers>);
 expect(html).toContain("playback unknown; unsaved. Transcript details.");expect(html.match(/<button/g)).toHaveLength(1);
 expect(html).not.toContain("Collapsed evidence");expect(html).not.toContain("aria-live");
});
