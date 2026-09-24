/**
 * Each block draws something other than colour for a cued tone (#309).
 *
 * Every test renders a component with a cued tone and an uncued one, then
 * reads the markup: a toned element carries `data-tone`, and a cued one
 * contains one `<svg data-cue="…">` while teal, blue, neutral, ink and dim
 * contain none. That difference is what a grayscale print keeps, and it is
 * the assertion — not a colour, which is what the tones already had.
 *
 * `renderToStaticMarkup`, like the kit's other unit tests: this is a pure
 * function of props. Whether the glyph lands where the ruling drew it at a
 * phone width is the visual suite's question (`tests/visual`), and whether
 * every element in a cued tone in the print story carries one is the
 * `Blocks/In print` story's.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ContactCard } from "../src/blocks/ContactCard.js";
import { ScheduleList } from "../src/blocks/ScheduleList.js";
import { StatTiles } from "../src/blocks/StatTiles.js";
import { StepList } from "../src/blocks/StepList.js";
import { TimelineList } from "../src/blocks/TimelineList.js";
import { TrendChart } from "../src/blocks/TrendChart.js";
import { ComparisonTable } from "../src/conversation/ComparisonTable.js";
import { DataTable } from "../src/evidence/DataTable.js";
import { Receipt } from "../src/evidence/Receipt.js";
import { ICONS, type IconName } from "../src/primitives/Icon.js";

/**
 * The toned elements of a render, in document order, each with the cue keys
 * drawn inside it. A cue SVG is always the first child of the element its
 * tone colours, so splitting the markup at each `data-tone` puts every SVG
 * in the segment of the element that drew it.
 */
function toned(html: string): { tone: string; cues: string[] }[] {
  const [before, ...chunks] = html.split('data-tone="');
  // Nothing outside a toned element draws a cue.
  expect(before).not.toContain("data-cue");
  drawsItsGlyph(html);
  return chunks.map((chunk) => ({
    tone: chunk.slice(0, chunk.indexOf('"')),
    cues: [...chunk.matchAll(/data-cue="([^"]+)"/g)].map((m) => m[1]!),
  }));
}

/** The shapes inside the Lucide glyph an icon key names. */
function shapesOf(key: IconName): string {
  const Glyph = ICONS[key];
  return /<svg[^>]*>(.*)<\/svg>/s.exec(renderToStaticMarkup(<Glyph />))![1]!;
}

/**
 * Every cue SVG draws the glyph its `data-cue` names, not merely the label:
 * a renderer that kept the key and drew another icon would pass a test that
 * read the attribute alone.
 */
function drawsItsGlyph(html: string) {
  const svgs = [...html.matchAll(/<svg[^>]*data-cue="([^"]+)"[^>]*>(.*?)<\/svg>/gs)];
  expect(svgs.length).toBe(html.split("data-cue=").length - 1);
  for (const [, key, shapes] of svgs) {
    expect(shapes!.length).toBeGreaterThan(0);
    expect({ key, shapes }).toEqual({ key: key!, shapes: shapesOf(key as IconName) });
  }
}

/** Every cue SVG is hidden from the accessibility tree: it repeats colour. */
function allHidden(html: string) {
  const svgs = html.match(/<svg[^>]*data-cue=[^>]*>/g) ?? [];
  expect(svgs.length).toBeGreaterThan(0);
  for (const svg of svgs) expect(svg).toContain('aria-hidden="true"');
}

describe("ComparisonTable", () => {
  test("a judged column or cell draws its glyph; teal, blue, neutral, ink and dim draw none", () => {
    const html = renderToStaticMarkup(
      <ComparisonTable
        columns={[
          { label: "A", tone: "red", recommended: true },
          { label: "B", tone: "teal" },
          { label: "C" },
        ]}
        rows={[
          { label: "r1", cells: [{ v: "x", tone: "gold" }, { v: "y", tone: "amber" }, { v: "z", tone: "purple" }] },
          { label: "r2", cells: [{ v: "x", tone: "blue" }, { v: "y", tone: "neutral" }, { v: "z", tone: "dim" }] },
          // Untoned: teal in the recommended column, ink elsewhere.
          { label: "r3", cells: ["x", "y", { v: "z", tone: "ink" }] },
        ]}
        footnote=""
      />,
    );
    expect(toned(html)).toEqual([
      { tone: "red", cues: ["failed"] },
      { tone: "teal", cues: [] },
      { tone: "ink", cues: [] },
      { tone: "gold", cues: ["fyi"] },
      { tone: "amber", cues: ["hand"] },
      { tone: "purple", cues: ["unverified"] },
      { tone: "blue", cues: [] },
      { tone: "neutral", cues: [] },
      { tone: "dim", cues: [] },
      { tone: "teal", cues: [] },
      { tone: "ink", cues: [] },
      { tone: "ink", cues: [] },
    ]);
    allHidden(html);
    // Before the text, at 11px, in a cell and in a column header alike.
    const cell = html.split('data-tone="gold"')[1]!;
    expect(cell.indexOf("<svg")).toBeLessThan(cell.indexOf(">x<"));
    expect(cell).toContain('width="11"');
    const header = html.split('data-tone="red"')[1]!;
    expect(header.indexOf("<svg")).toBeGreaterThan(-1);
    expect(header.indexOf("<svg")).toBeLessThan(header.indexOf(">A<"));
  });
});

describe("StatTiles", () => {
  test("a tile to act on draws its glyph after the value, at 13px", () => {
    const html = renderToStaticMarkup(
      <StatTiles
        tiles={[
          { label: "a", value: "1", tone: "red" },
          { label: "b", value: "2", tone: "gold" },
          { label: "c", value: "3", tone: "amber" },
          { label: "d", value: "4", tone: "purple" },
          { label: "e", value: "5", tone: "teal" },
          { label: "f", value: "6", tone: "blue" },
          { label: "g", value: "7", tone: "neutral" },
          { label: "h", value: "8", tone: "dim" },
          { label: "i", value: "9" },
        ]}
      />,
    );
    expect(toned(html)).toEqual([
      { tone: "red", cues: ["failed"] },
      { tone: "gold", cues: ["fyi"] },
      { tone: "amber", cues: ["hand"] },
      { tone: "purple", cues: ["unverified"] },
      { tone: "teal", cues: [] },
      { tone: "blue", cues: [] },
      { tone: "neutral", cues: [] },
      { tone: "dim", cues: [] },
      { tone: "ink", cues: [] },
    ]);
    allHidden(html);
    const tile = html.split('data-tone="red"')[1]!;
    expect(tile.indexOf(">1<")).toBeLessThan(tile.indexOf("<svg"));
    expect(tile).toContain('width="13"');
  });

  test("the subject icon and the judgement glyph are two different marks", () => {
    const html = renderToStaticMarkup(<StatTiles tiles={[{ label: "failed runs", value: "1", icon: "failed", tone: "red" }]} />);
    // Two triangles: the subject's, in the label row, has no `data-cue`.
    expect(html.match(/lucide-triangle-alert/g)).toHaveLength(2);
    expect(html.match(/data-cue="failed"/g)).toHaveLength(1);
  });
});

describe("TrendChart", () => {
  const props = { label: "x", value: "1", values: [1, 2, 3], ticks: ["a", "b", "c"] };

  test("a red delta leads with the glyph at 12px; a teal one has none", () => {
    const red = renderToStaticMarkup(<TrendChart {...props} delta="+18%" deltaTone="red" />);
    expect(toned(red)).toEqual([{ tone: "red", cues: ["failed"] }]);
    allHidden(red);
    const pill = red.split('data-tone="red"')[1]!;
    expect(pill.indexOf("<svg")).toBeLessThan(pill.indexOf("+18%"));
    expect(pill).toContain('width="12"');

    const teal = renderToStaticMarkup(<TrendChart {...props} delta="-6%" deltaTone="teal" />);
    expect(toned(teal)).toEqual([{ tone: "teal", cues: [] }]);
    // The series tone is not a judgement and draws nothing.
    expect(renderToStaticMarkup(<TrendChart {...props} tone="red" />)).not.toContain("data-cue");
  });
});

describe("DataTable", () => {
  test("a judged cell draws its glyph before the figure; neutral and untoned cells draw none", () => {
    const html = renderToStaticMarkup(
      <DataTable
        columns={[{ label: "where" }, { label: "lost", w: 44, align: "right" }]}
        rows={[
          { cells: [{ v: "Ismarus" }, { v: "72", tone: "gold" }] },
          { cells: [{ v: "Laestrygonians", tone: "neutral" }, { v: "484", tone: "red" }] },
          { cells: [{ v: "Aeaea", tone: "blue" }, { v: "1", tone: "teal" }] },
          { cells: [{ v: "Ogygia", tone: "amber" }, { v: "0", tone: "purple" }] },
        ]}
      />,
    );
    expect(toned(html)).toEqual([
      { tone: "ink", cues: [] },
      { tone: "gold", cues: ["fyi"] },
      { tone: "neutral", cues: [] },
      { tone: "red", cues: ["failed"] },
      { tone: "blue", cues: [] },
      { tone: "teal", cues: [] },
      { tone: "amber", cues: ["hand"] },
      { tone: "purple", cues: ["unverified"] },
    ]);
    allHidden(html);
    // Left of the digits, so they keep their right edge.
    const cell = html.split('data-tone="red"')[1]!;
    expect(cell.indexOf("<svg")).toBeLessThan(cell.indexOf(">484<"));
    expect(cell).toContain('width="11"');
  });
});

describe("Receipt", () => {
  test("a judged row draws its glyph leading the value, and break-all stays", () => {
    const html = renderToStaticMarkup(
      <Receipt
        title=""
        footnote=""
        rows={[
          { k: "tool", v: "WebFetch", tone: "amber" },
          { k: "target", v: "winds.example.invalid", tone: "purple" },
          { k: "writes", v: "voyage/_index.md", tone: "teal" },
          { k: "run", v: "run #4c1", tone: "neutral" },
          { k: "coverage", v: "82%", tone: "red" },
          { k: "broken", v: "23", tone: "gold" },
          { k: "spend", v: "~$0.02" },
        ]}
      />,
    );
    expect(toned(html)).toEqual([
      { tone: "amber", cues: ["hand"] },
      { tone: "purple", cues: ["unverified"] },
      { tone: "teal", cues: [] },
      { tone: "neutral", cues: [] },
      { tone: "red", cues: ["failed"] },
      { tone: "gold", cues: ["fyi"] },
      { tone: "dim", cues: [] },
    ]);
    allHidden(html);
    const row = html.split('data-tone="red"')[1]!;
    expect(row.slice(0, row.indexOf(">"))).toContain("word-break:break-all");
    expect(row.indexOf("<svg")).toBeLessThan(row.indexOf("82%"));
    // The title and scope icons are shapes already, and carry no cue.
    const titled = renderToStaticMarkup(<Receipt rows={[{ k: "a", v: "b" }]} titleTone="red" footTone="red" />);
    expect(titled).not.toContain("data-cue");
  });
});

describe("StepList", () => {
  const bubble = (html: string, state: string) => {
    const tag = html.match(new RegExp(`<span data-state="${state}" style="([^"]*)"`));
    expect(tag).not.toBeNull();
    return tag![1]!;
  };

  test("the current step wears a 2px ring, a todo step 1px, and both bubbles stay 22px", () => {
    const html = renderToStaticMarkup(
      <StepList
        variant="progress"
        steps={[
          { title: "a", state: "done" },
          { title: "b", state: "current" },
          { title: "c", state: "todo" },
        ]}
      />,
    );
    const current = bubble(html, "current");
    const todo = bubble(html, "todo");
    expect(current).toMatch(/border:2px solid/);
    expect(todo).toMatch(/border:1px solid/);
    for (const style of [current, todo, bubble(html, "done")]) {
      expect(style).toContain("width:22px");
      expect(style).toContain("height:22px");
      expect(style).toContain("box-sizing:border-box");
    }
    expect(bubble(html, "done")).toContain("border:none");
  });
});

describe("TimelineList", () => {
  test("an event kind with a glyph draws it in the gutter; noted, blue and untoned keep the dot", () => {
    const html = renderToStaticMarkup(
      <TimelineList
        items={[
          { time: "1", title: "decided", tone: "teal" },
          { time: "2", title: "agent acted", tone: "amber" },
          { time: "3", title: "failed", tone: "red" },
          { time: "4", title: "from outside", tone: "purple" },
          { time: "5", title: "watch it", tone: "gold" },
          { time: "6", title: "a company", tone: "blue" },
          { time: "7", title: "noted", tone: "neutral" },
          { time: "8", title: "untoned" },
        ]}
      />,
    );
    expect(toned(html)).toEqual([
      { tone: "teal", cues: ["confirm"] },
      { tone: "amber", cues: ["agent"] },
      { tone: "red", cues: ["failed"] },
      { tone: "purple", cues: ["unverified"] },
      { tone: "gold", cues: ["fyi"] },
      { tone: "blue", cues: [] },
      { tone: "neutral", cues: [] },
      { tone: "neutral", cues: [] },
    ]);
    allHidden(html);
    expect(html.match(/width="11"/g)).toHaveLength(5);
    // Each mark is the first thing in the gutter column, above its connector
    // and apart from the title: a glyph moved beside the title is not in it.
    const gutters = [...html.matchAll(/<div style="[^"]*flex-direction:column[^"]*width:11px[^"]*"><span data-tone="([^"]+)"[^>]*>(<span[^>]*><svg[^>]*data-cue="([^"]+)")?/g)];
    expect(gutters.map((m) => [m[1], m[3] ?? null])).toEqual([
      ["teal", "confirm"],
      ["amber", "agent"],
      ["red", "failed"],
      ["purple", "unverified"],
      ["gold", "fyi"],
      ["blue", null],
      ["neutral", null],
      ["neutral", null],
    ]);
    // A dot row still draws the 7px dot, in the same 11px box.
    const dot = html.split('data-tone="blue"')[1]!;
    expect(dot).toContain("width:7px");
    expect(dot).not.toContain("<svg");
    expect(dot.slice(0, dot.indexOf(">"))).toContain("width:11px");
  });

  test("the glyph breathes where the dot did, and only when asked", () => {
    const html = renderToStaticMarkup(
      <TimelineList
        items={[
          { time: "1", title: "still going", tone: "teal", pulse: true },
          { time: "2", title: "done", tone: "teal" },
        ]}
      />,
    );
    const [going, done] = html.split('data-tone="teal"').slice(1);
    expect(going!.slice(0, going!.indexOf("<svg"))).toContain("animation:breathe");
    expect(done!.slice(0, done!.indexOf("<svg"))).not.toContain("animation");
  });
});

describe("ScheduleList", () => {
  test("a claim on you leads the title with its glyph; an FYI and the uncued tones draw none", () => {
    const html = renderToStaticMarkup(
      <ScheduleList
        groups={[
          {
            day: "today",
            items: [
              { time: "1", title: "deadline", tone: "red" },
              { time: "2", title: "yours", tone: "amber" },
              { time: "3", title: "the agent's", tone: "teal" },
              { time: "4", title: "watch it", tone: "gold" },
              { time: "5", title: "untrusted", tone: "purple" },
              { time: "6", title: "a company", tone: "blue" },
              { time: "7", title: "grey", tone: "neutral" },
              { time: "8", title: "an FYI" },
            ],
          },
        ]}
      />,
    );
    expect(toned(html)).toEqual([
      { tone: "red", cues: ["deadline"] },
      { tone: "amber", cues: ["hand"] },
      { tone: "teal", cues: ["agent"] },
      { tone: "gold", cues: ["fyi"] },
      { tone: "purple", cues: ["unverified"] },
      { tone: "blue", cues: [] },
      { tone: "neutral", cues: [] },
      { tone: "edge", cues: [] },
    ]);
    allHidden(html);
    const title = html.split('data-tone="red"')[1]!;
    expect(title.indexOf("<svg")).toBeLessThan(title.indexOf("deadline<"));
    expect(title).toContain('width="11"');
  });
});

describe("ContactCard", () => {
  test("a company and a project lead the role line with a kind word; a person does not", () => {
    const company = renderToStaticMarkup(<ContactCard kind="company" label="The council" role="Olympos" facts={[]} />);
    expect(company).toMatch(/<span data-kind="company"[^>]*>company ·<\/span>Olympos/);
    expect(company.split('data-kind="company"')[1]!.slice(0, 200)).toContain("text-transform:uppercase");
    const project = renderToStaticMarkup(<ContactCard kind="project" label="Get home" role="Active" facts={[]} />);
    expect(project).toMatch(/<span data-kind="project"[^>]*>project ·<\/span>Active/);
    const person = renderToStaticMarkup(<ContactCard kind="person" label="Penelope" role="Wife" facts={[]} />);
    expect(person).not.toContain("data-kind");
    // No role, no separator: the word stands alone rather than trailing a dot.
    const bare = renderToStaticMarkup(<ContactCard kind="company" label="The council" role="" facts={[]} />);
    expect(bare).toMatch(/<span data-kind="company"[^>]*>company<\/span>/);
  });

  test("a judged fact draws its glyph leading the value; teal, neutral and dim draw none", () => {
    const html = renderToStaticMarkup(
      <ContactCard
        label="Penelope"
        facts={[
          { k: "at", v: "Ithaca", tone: "teal" },
          { k: "last spoke", v: "20 years ago", tone: "red" },
          { k: "holding", v: "the estate", tone: "gold" },
          { k: "asked for", v: "nothing", tone: "neutral" },
          { k: "open threads", v: "2" },
        ]}
      />,
    );
    expect(toned(html)).toEqual([
      { tone: "teal", cues: [] },
      { tone: "red", cues: ["failed"] },
      { tone: "gold", cues: ["fyi"] },
      { tone: "neutral", cues: [] },
      { tone: "dim", cues: [] },
    ]);
    allHidden(html);
    const fact = html.split('data-tone="red"')[1]!;
    expect(fact.indexOf("<svg")).toBeLessThan(fact.indexOf("20 years ago"));
  });
});
