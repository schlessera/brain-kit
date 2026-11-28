import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { valueInk } from "../src/internal/tone-ink.js";
import { DataTable } from "../src/evidence/DataTable.js";
import { Label } from "../src/primitives/Label.js";
import { Meter } from "../src/primitives/Meter.js";
import { PathRef } from "../src/primitives/PathRef.js";
import { StatusDot } from "../src/primitives/StatusDot.js";
import { accent, color } from "../src/tokens.js";
import type { ValueTone } from "../src/types.js";

// #4728: components index `accent` directly. Kit props are typed, not
// validated, so a tone outside the union must still read as the component's
// own fallback colour, never throw and take the component down.
describe("tone lookups keep each site's fallback for an unknown tone (#4728)", () => {
  const unknown = "sea-grey" as never;

  test("ink: PathRef falls back to teal", () => {
    const html = renderToStaticMarkup(<PathRef text="ithaca/raft.md" tone={unknown} />);
    expect(html).toContain(`color:${accent.teal.ink}`);
  });

  test("fill: Meter falls back to teal", () => {
    const html = renderToStaticMarkup(<Meter value={40} tone={unknown} />);
    expect(html).toContain(`background:${accent.teal.fill}`);
  });

  test("mark: StatusDot falls back to amber", () => {
    const html = renderToStaticMarkup(<StatusDot tone={unknown} />);
    expect(html).toContain(`background:${accent.amber.mark}`);
  });

  test("valueInk: Label falls back to neutral", () => {
    const html = renderToStaticMarkup(<Label text="Crew" tone={unknown} />);
    expect(html).toContain(`color:${accent.neutral.ink}`);
  });

  // #4947: `dim` is a value tone, but neither a label tone nor a cell tone.
  test("valueInk: Label reads an out-of-union dim as neutral, not dim ink", () => {
    const html = renderToStaticMarkup(<Label text="Crew" tone={"dim" as never} />);
    expect(html).toContain(`color:${accent.neutral.ink}`);
    expect(html).not.toContain(`color:${color.inkDim}`);
  });

  test("valueInk: a DataTable cell reads an out-of-union dim as ink, not dim ink", () => {
    const html = renderToStaticMarkup(<DataTable columns={[{ label: "Crew" }]} rows={[{ cells: [{ v: "Elpenor", tone: "dim" as never }] }]} />);
    expect(html).toMatch(/data-tone="dim"[^>]*color:([^;"]+)/);
    expect(html.match(/data-tone="dim"[^>]*color:([^;"]+)/)?.[1]).toBe(color.ink);
  });
});

describe("valueInk (#4728)", () => {
  const accents = ["amber", "gold", "teal", "purple", "blue", "red", "neutral"] as const;
  for (const tone of accents) test(`${tone} is the accent's ink`, () => {
    expect(valueInk(tone, "dim")).toBe(accent[tone].ink);
  });
  test("ink and dim are the two plain inks", () => {
    expect(valueInk("ink", "dim")).toBe(color.ink);
    expect(valueInk("dim", "ink")).toBe(color.inkDim);
  });
  test("an unknown tone reads as the fallback", () => {
    expect(valueInk("sea-grey" as ValueTone, "dim")).toBe(color.inkDim);
    expect(valueInk("sea-grey" as ValueTone, "teal")).toBe(accent.teal.ink);
  });
});
