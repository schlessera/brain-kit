import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ToolList, ToolRow, type ToolRowProps } from "../src/storage/ToolRow.js";
import {
  toolAction,
  toolChangeLine,
  toolCountsLine,
  toolHeadroomView,
  toolResultLines,
  toolStateLine,
  toolStateText,
  type ToolRunState,
} from "../src/storage/tool-row-model.js";

const GB = 1_000_000_000;
const fig = (gb: number) => ({ bytes: gb * GB, text: `${gb} GB` });
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'");
const row = (p: Partial<ToolRowProps>) =>
  renderToStaticMarkup(<ToolRow name="Pack Git objects" description="Packs loose objects." state="never" onRun={() => {}} onCancel={() => {}} {...p} />);

describe("tool state line", () => {
  const cases: Array<[ToolRunState, string]> = [
    ["never", "○ Never run"],
    ["waiting", "◌ Waiting · queued 12 Jul 03:08"],
    ["running", "◐ Running · since 12 Jul 03:08"],
    ["complete", "● Done · 12 Jul 03:08"],
    ["partial", "◑ Partly done · 12 Jul 03:08"],
    ["refused", "⊘ Refused · 12 Jul 03:08"],
    ["cancelled", "◇ Cancelled · 12 Jul 03:08"],
    ["unknown", "? Outcome unknown · 12 Jul 03:08"],
  ];
  for (const [state, expected] of cases) {
    test(`${state} reads as a distinct glyph and word`, () => {
      const line = toolStateLine({ state, at: "12 Jul 03:08" });
      expect(`${line.glyph} ${toolStateText(line)}`).toBe(expected);
    });
  }
  test("every state has its own glyph-and-word pair, so greyscale keeps them apart", () => {
    const pairs = cases.map(([state]) => { const l = toolStateLine({ state }); return `${l.glyph}${l.word}`; });
    expect(new Set(pairs).size).toBe(pairs.length);
  });
  test("a missing time adds no dangling separator", () => {
    expect(toolStateText(toolStateLine({ state: "complete" }))).toBe("Done");
    expect(toolStateText(toolStateLine({ state: "running" }))).toBe("Running");
  });
  test("unavailable overrides the receipt state and says why", () => {
    const line = toolStateLine({ state: "complete", at: "12 Jul", available: false, unavailableReason: "Git not installed" });
    expect(`${line.glyph} ${toolStateText(line)}`).toBe("⊘ Not available here · Git not installed");
  });
  test("cancelling applies only while busy", () => {
    expect(toolStateLine({ state: "running", cancelling: true }).word).toBe("Cancelling…");
    expect(toolStateLine({ state: "waiting", cancelling: true }).word).toBe("Cancelling…");
    expect(toolStateLine({ state: "cancelled", cancelling: true }).word).toBe("Cancelled");
  });
});

describe("measured change", () => {
  test("a delta is labelled available and unattributed", () => {
    expect(toolChangeLine({ delta: "+1.8 GB" })).toBe("Available +1.8 GB · unattributed");
    expect(toolChangeLine({ delta: "−0.2 GB" })).toBe("Available −0.2 GB · unattributed");
  });
  test("an unknown before or after renders as not measured with its reason, never unknown → unknown", () => {
    for (const reason of ["before measurement missing", "after measurement missing", "volume changed", "measurement incomplete"] as const) {
      const line = toolChangeLine({ notMeasured: reason });
      expect(line).toBe(`Change not measured · ${reason}`);
      expect(line).not.toMatch(/unknown|→|\b0\b/);
    }
  });
  test("no change, or an empty delta, is not measured rather than blank or zero", () => {
    expect(toolChangeLine(undefined)).toBe("Change not measured · measurement incomplete");
    expect(toolChangeLine(null)).toBe("Change not measured · measurement incomplete");
    expect(toolChangeLine({ delta: "  " })).toBe("Change not measured · measurement incomplete");
  });
  test("the row never prints unknown → unknown for a complete run without observations", () => {
    const html = text(row({ state: "complete", at: "12 Jul 03:10", change: { notMeasured: "before measurement missing" } }));
    expect(html).toContain("Change not measured · before measurement missing");
    expect(html).not.toMatch(/unknown|→/);
  });
});

describe("result lines", () => {
  test("counts are the non-null ones, joined, and suspension is said", () => {
    expect(toolCountsLine({ removed: 41, failed: 3, deferred: 2, packed: null })).toBe("Removed 41 · failed 3 · deferred 2");
    expect(toolCountsLine({ removed: 0, failed: null })).toBe("Removed 0");
    expect(toolCountsLine({ removed: 5, suspended: true })).toBe("Removed 5 · paused by the brain");
    expect(toolCountsLine({ removed: null, failed: undefined })).toBeNull();
    expect(toolCountsLine({ removed: Number.NaN, failed: -1 })).toBeNull();
  });
  test("each receipt state's copy", () => {
    expect(toolResultLines({ state: "never" })).toEqual([]);
    expect(toolResultLines({ state: "waiting" })).toEqual(["Starts when the current job finishes"]);
    expect(toolResultLines({ state: "running" })).toEqual([]);
    expect(toolResultLines({ state: "partial", counts: { removed: 41, failed: 3 }, change: { delta: "+0.3 GB" } }))
      .toEqual(["Removed 41 · failed 3", "Available +0.3 GB · unattributed"]);
    expect(toolResultLines({ state: "refused", reason: "Not enough available space to pack" })).toEqual(["Not enough available space to pack"]);
    expect(toolResultLines({ state: "refused", reason: " " })).toEqual(["No reason recorded"]);
    expect(toolResultLines({ state: "cancelled" })).toEqual(["Stopped before finishing · change not measured"]);
    expect(toolResultLines({ state: "unknown", reason: "no receipt after restart" })).toEqual(["Couldn't confirm the result · no receipt after restart"]);
    expect(toolResultLines({ state: "unknown" })).toEqual(["Couldn't confirm the result"]);
    expect(toolResultLines({ state: "complete", available: false })).toEqual([]);
  });
  test("running reads Working… only, with no count", () => {
    const html = row({ state: "running", at: "03:09" });
    expect(html).toMatch(/data-tool-working=""><span class="bk-tool-stripe" aria-hidden="true"><\/span><span>Working…<\/span><\/span>/);
    expect(text(html)).not.toMatch(/\bdone\b|\d+ of \d+/);
  });
});

describe("action", () => {
  test("Run, Try again, Cancel, or nothing when unavailable", () => {
    expect(toolAction({ state: "never" }).label).toBe("Run");
    expect(toolAction({ state: "complete" }).label).toBe("Run");
    for (const state of ["refused", "partial", "unknown", "cancelled"] as const) expect(toolAction({ state }).label).toBe("Try again");
    expect(toolAction({ state: "running" })).toEqual({ kind: "cancel", label: "Cancel", disabled: false });
    expect(toolAction({ state: "waiting", cancelling: true })).toEqual({ kind: "cancel", label: "Cancelling…", disabled: true });
    expect(toolAction({ state: "never", available: false }).kind).toBe("none");
  });
  test("the button is the quiet tone, never primary, with the maintain chip beside it", () => {
    const html = row({ state: "never" });
    expect(html).toContain(">maintain<");
    expect(html).toContain("aria-label=\"Run Pack Git objects\"");
    expect(html, "quiet paint: no fill").toContain("--hv-rest-bg:transparent");
    expect(html, "quiet ink").toContain("--hv-rest-fg:var(--bk-color-ink-mute)");
    expect(html).not.toContain("var(--bk-amber-fill)");
  });
  test("short headroom leaves Run enabled", () => {
    const html = row({ state: "never", headroom: { required: fig(2.1), available: fig(1.7), shortfall: "0.4 GB" } });
    expect(html).toContain("▲ Short by 0.4 GB · needs 2.1 GB · 1.7 GB available");
    expect(html).not.toContain("aria-disabled");
  });
  test("unavailable has no button and no meter", () => {
    const html = row({ available: false, unavailableReason: "Git not installed", headroom: { required: fig(2.1), available: fig(5.9) } });
    expect(html).not.toMatch(/role="button"|role="meter"/);
    expect(text(html)).toContain("Not available here · Git not installed");
  });
});

describe("headroom", () => {
  test("hidden for a tool without headroom", () => {
    expect(toolHeadroomView(undefined)).toEqual({ kind: "hidden" });
  });
  test("an absent estimate is a ? mark in words, never a bar", () => {
    const view = toolHeadroomView({ required: null, available: fig(5.9) });
    expect(view).toEqual({ kind: "text", text: "? · needs an estimate from a measured run", evidence: "no-estimate" });
    const html = row({ headroom: { required: null, available: fig(5.9) } });
    expect(html).not.toMatch(/role="meter"|bk-tool-meter/);
  });
  test("a zero or invalid estimate counts as absent, never as a zero-width bar", () => {
    for (const bytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(toolHeadroomView({ required: { bytes, text: "0 B" }, available: fig(5.9) }).kind).toBe("text");
    }
    expect(toolHeadroomView({ required: { bytes: GB, text: " " }, available: fig(5.9) }).kind).toBe("text");
  });
  test("an absent observation keeps the estimate in words", () => {
    expect(toolHeadroomView({ required: fig(2.1), available: null }))
      .toEqual({ kind: "text", text: "? · needs 2.1 GB · available not measured", evidence: "no-observation" });
  });
  test("a note stands in for missing evidence, but not for a drawable meter", () => {
    expect(toolHeadroomView({ required: null, available: null, note: "Policy copy." })).toEqual({ kind: "text", text: "Policy copy.", evidence: "note" });
    expect(toolHeadroomView({ required: fig(2.1), available: fig(5.9), note: "Policy copy." }).kind).toBe("meter");
  });
  test("enough: the fill is the whole track and the marker sits at the needed share", () => {
    const view = toolHeadroomView({ required: fig(2.1), available: fig(5.9) });
    if (view.kind !== "meter") throw new Error("expected a meter");
    expect(view.short).toBe(false);
    expect(view.availablePercent).toBe(100);
    expect(view.requiredPercent).toBeCloseTo((2.1 / 5.9) * 100, 6);
    expect(view.caption).toBe("needs 2.1 GB · 5.9 GB available");
    expect(view.valueText).toBe("needs 2.1 GB, 5.9 GB available");
  });
  test("short: the fill stops at available, the marker at the track's end", () => {
    const view = toolHeadroomView({ required: fig(2.1), available: fig(1.7), shortfall: "0.4 GB" });
    if (view.kind !== "meter") throw new Error("expected a meter");
    expect(view.short).toBe(true);
    expect(view.availablePercent).toBeCloseTo((1.7 / 2.1) * 100, 6);
    expect(view.requiredPercent).toBe(100);
    expect(view.caption).toBe("▲ Short by 0.4 GB · needs 2.1 GB · 1.7 GB available");
    expect(view.valueText).toBe("Short by 0.4 GB, needs 2.1 GB, 1.7 GB available");
  });
  test("exactly enough is not short; a full disk is short with an empty fill", () => {
    const equal = toolHeadroomView({ required: fig(2), available: fig(2) });
    expect(equal.kind === "meter" && equal.short).toBe(false);
    const full = toolHeadroomView({ required: fig(2), available: { bytes: 0, text: "0 B" } });
    if (full.kind !== "meter") throw new Error("expected a meter");
    expect(full.short).toBe(true);
    expect(full.availablePercent).toBe(0);
    expect(full.caption).toBe("▲ Short · needs 2 GB · 0 B available");
  });
  test("percentages stay inside the track for any valid pair", () => {
    for (const [r, a] of [[1, 1e6], [1e6, 1], [3, 3], [7, 0]] as const) {
      const view = toolHeadroomView({ required: { bytes: r, text: "r" }, available: { bytes: a, text: "a" } });
      if (view.kind !== "meter") throw new Error("expected a meter");
      for (const n of [view.availablePercent, view.requiredPercent]) {
        expect(Number.isFinite(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(100);
      }
    }
  });
  test("running replaces the headroom with the working stripe", () => {
    const html = row({ state: "running", at: "03:09", headroom: { required: fig(2.1), available: fig(5.9) } });
    expect(html).not.toContain("role=\"meter\"");
    expect(html).toContain("bk-tool-stripe");
    expect(text(html)).toContain("Working…");
  });
});

describe("tool list", () => {
  test("one footnote, rows as list items, and a polite live region", () => {
    const html = renderToStaticMarkup(
      <ToolList announcement="Pack Git objects done.">
        <ToolRow name="A" description="a" state="never" onRun={() => {}} />
        <ToolRow name="B" description="b" state="never" onRun={() => {}} />
      </ToolList>,
    );
    expect(html.match(/<li>/g)).toHaveLength(2);
    expect(html.match(/data-tool-footnote/g)).toHaveLength(1);
    expect(text(html)).toContain("Nothing else is safe to remove automatically. Use Find large files to review the rest.");
    expect(html).toMatch(/aria-live="polite"[^>]*>Pack Git objects done\.</);
    expect(html).not.toMatch(/Needs headroom/);
  });
});

describe("motion", () => {
  test("the running stripe is parked in the one reduced-motion override", async () => {
    const css = await Bun.file(new URL("../src/tokens.css", import.meta.url)).text();
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
    const block = css.slice(start, css.indexOf("\n}\n", start));
    expect(block).toContain(".bk-tool-row .bk-tool-stripe { animation: none; }");
    expect(css).toMatch(/\.bk-tool-stripe \{[^}]*animation: bk-tool-stripe/);
  });
});

describe("held action", () => {
  test("actionDisabled keeps the button in place, inert", () => {
    const html = row({ state: "running", actionDisabled: true });
    expect(html).toContain('aria-label="Cancel Pack Git objects"');
    expect(html).toContain('aria-disabled="true"');
    expect(row({ state: "running" })).not.toContain('aria-disabled="true"');
  });
});
