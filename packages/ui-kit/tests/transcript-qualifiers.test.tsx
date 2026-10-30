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
});

test("server-rendered legend remains a discoverable native action without copying all evidence into transcript", () => {
  const html = renderToStaticMarkup(<TranscriptSymbols />);
  expect(html).toContain('type="button"');
  expect(html).toContain("Transcript symbols");
  expect(html).not.toContain("Received audio chunks played");
});
