import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { TranscriptQualifiers } from "../src/conversation/TranscriptQualifiers.js";
import { SpokenTurn } from "../src/voice/SpokenTurn.js";

const css = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const heard = { kind: "recognized", source: "Gemini Live", evidenceLabel: "Technical evidence", children: <p>Collapsed evidence</p> } as const;

test("the glyph trigger stays the default, unchanged", () => {
  const plain = renderToStaticMarkup(<TranscriptQualifiers {...heard} />);
  expect(renderToStaticMarkup(<TranscriptQualifiers {...heard} trigger="glyphs" />)).toBe(plain);
  expect(plain).toContain('class="bk-control bk-transcript-qualifiers"');
  expect(plain).toContain("bk-transcript-glyphs");
  expect(plain).not.toContain("data-transcript-trigger");
  expect(plain).not.toContain(">Details<");
});

test("the reveal trigger is one named Details stop with no glyph and no tooltip", () => {
  const html = renderToStaticMarkup(<TranscriptQualifiers {...heard} trigger="reveal" />);
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain('aria-label="Recognized speech; Gemini Live; unverified. Transcript details."');
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html).toContain('data-transcript-trigger="reveal"');
  expect(html).toContain('<span class="bk-transcript-pill" aria-hidden="true">Details</span>');
  expect(html).not.toContain("<svg");
  expect(html).not.toContain("bk-transcript-qualifiers");
  expect(html).not.toContain("aria-describedby");
  expect(html).not.toContain("Collapsed evidence");
});

test("a spoken turn without details renders as before; with details it carries one reveal stop", () => {
  const plain = renderToStaticMarkup(<SpokenTurn speaker="you">When is Calypso’s axe back?</SpokenTurn>);
  expect(plain.startsWith('<div class="bk-spoken-turn" data-speaker="you"><div class="bk-spoken-bubble">')).toBe(true);
  expect(plain).not.toContain("<button");
  for (const speaker of ["you", "brain"] as const) {
    const html = renderToStaticMarkup(<SpokenTurn speaker={speaker} details={heard}>When is Calypso’s axe back?</SpokenTurn>);
    expect(html).toContain(`data-speaker="${speaker}" data-details=""`);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html.match(/data-transcript-trigger="reveal"/g)).toHaveLength(1);
    expect(html).not.toContain("bk-transcript-glyphs");
    expect(html.match(/<svg/g), "only the spoken mark").toHaveLength(1);
  }
});

test("a touch long-press never selects the turn's words, and the pill appears without fading under reduced motion", () => {
  const hoverNone = css.slice(css.indexOf("@media (hover: none)"));
  expect(css).toMatch(/@media \(hover: none\) \{\s*\.bk-spoken-turn\[data-details\] \{ user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; \}/);
  expect(hoverNone.length).toBeGreaterThan(0);
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  // A media query adds no specificity: the reduced rule (three classes or
  // attributes) must outrank every shown rule (two), declared further down.
  expect(reduced).toContain(".bk-spoken-turn[data-details] .bk-transcript-reveal { transition: none; }");
  expect(css).toContain('[data-motion="reduce"] .bk-spoken-turn[data-details] .bk-transcript-reveal { transition: none; }');
  const shown = css.match(/^(.*) \{ clip-path: none; opacity: 1; transition: opacity 120ms linear; \}$/m);
  expect(shown?.[1]).toBe('.bk-transcript-reveal:focus-visible, .bk-transcript-reveal[aria-expanded="true"], [data-reveal="true"] .bk-transcript-reveal');
});
