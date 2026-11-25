/**
 * CapacityGauge and VolumeCard markup (#4542): the meter's values, the
 * unknown mark, and the status words and glyphs. Geometry and keyboard
 * behaviour are browser claims, in the stories under `stories/storage/`.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CapacityGauge } from "../src/storage/CapacityGauge.js";
import { VolumeCard, VolumeGroup, type VolumeStatus } from "../src/storage/VolumeCard.js";

const GB = 1e9;
const LOW = { total: 161 * GB, used: 143.4 * GB, free: 17.6 * GB, available: 16.4 * GB };
const THRESHOLDS = { low: 0.1, veryLow: 0.05 };
const format = (bytes: number) => `${Number((bytes / GB).toPrecision(3))} GB`;

describe("CapacityGauge", () => {
  test("a measured gauge is a meter valued in bytes with the brief's valuetext", () => {
    const html = renderToStaticMarkup(<CapacityGauge capacity={LOW} thresholds={THRESHOLDS} format={format} />);
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain(`aria-valuemax="${161 * GB}"`);
    expect(html).toContain(`aria-valuenow="${16.4 * GB}"`);
    expect(html).toContain('aria-valuetext="16.4 GB available of 161 GB"');
    expect(html).toContain("Low below 16.1 GB (10%), very low below 8.05 GB (5%)");
  });

  test("unknown capacity is a text mark: no meter, no track, no segment", () => {
    const html = renderToStaticMarkup(<CapacityGauge unknownReason="statfs unavailable" thresholds={THRESHOLDS} format={format} />);
    expect(html).toContain("Capacity not measured · statfs unavailable");
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain("data-segment");
    expect(html).not.toContain("data-tick");
  });

  test("inconsistent figures never become a bar", () => {
    const html = renderToStaticMarkup(
      <CapacityGauge capacity={{ total: 100, used: 70, free: 40, available: 30 }} thresholds={THRESHOLDS} format={format} />,
    );
    expect(html).toContain("Capacity not shown · figures inconsistent");
    expect(html).not.toContain('role="meter"');
    expect(html).not.toContain("data-segment");
  });
});

describe("VolumeCard", () => {
  const glyphs: Record<VolumeStatus, [string, string | null]> = {
    ok: ["OK", null],
    low: ["Low", "lucide-info"],
    "very-low": ["Very low", "lucide-triangle-alert"],
    "not-measured": ["Not measured", "lucide-circle-help"],
  };
  for (const [status, [word, glyph]] of Object.entries(glyphs) as Array<[VolumeStatus, [string, string | null]]>) {
    test(`${status} says "${word}"${glyph ? ` with ${glyph}` : " and no glyph"}`, () => {
      const html = renderToStaticMarkup(<VolumeCard name="Data volume" status={status} capacity={LOW} thresholds={THRESHOLDS} format={format} />);
      const chip = html.match(/data-volume-status=""[^>]*>([\s\S]*?)<\/span><\/span>/)?.[1] ?? "";
      expect(chip).toContain(word);
      if (glyph) expect(chip).toContain(glyph);
      else expect(chip).not.toContain("<svg");
    });
  }

  test("the copy says available, never free", () => {
    const html = renderToStaticMarkup(
      <VolumeCard name="Data volume" status="low" capacity={LOW} thresholds={THRESHOLDS} format={format} trend="−1.2 GB/day" runway="~14 days" stores={["Notes", "Library", "Index"]} />,
    );
    expect(html).toContain("16.4 GB");
    expect(html).toContain("available of 161 GB");
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(/\bfree\b/i);
  });

  test("an unidentified scope shows its event and no headline, gauge or facts", () => {
    const html = renderToStaticMarkup(
      <VolumeCard name="Unidentified volume" status="not-measured" unidentified="Write refused 12 Jul 14:02" thresholds={THRESHOLDS} format={format} trend="unknown" runway="unknown" />,
    );
    expect(html).toContain("Write refused 12 Jul 14:02 · couldn&#x27;t tell which volume");
    expect(html).not.toContain("available");
    expect(html).not.toContain("data-capacity");
    expect(html).not.toContain("Trend");
  });

  test("a card without onSelect is not a control", () => {
    const html = renderToStaticMarkup(<VolumeCard name="Data volume" status="ok" capacity={LOW} thresholds={THRESHOLDS} format={format} />);
    expect(html).not.toContain('role="radio"');
    expect(html).not.toContain("tabindex");
  });

  test("a group is one radiogroup whose only tab stop is the selected card", () => {
    const html = renderToStaticMarkup(
      <VolumeGroup
        thresholds={THRESHOLDS}
        format={format}
        selected="system"
        onSelect={() => {}}
        volumes={[
          { id: "data", name: "Data volume", status: "low", capacity: LOW },
          { id: "system", name: "System disk", status: "ok", capacity: LOW },
        ]}
      />,
    );
    expect(html).toContain('role="radiogroup" aria-label="Volumes"');
    const radios = [...html.matchAll(/role="radio" aria-checked="(true|false)"[^>]*tabindex="(-1|0)"/g)].map((m) => [m[1], m[2]]);
    expect(radios).toEqual([
      ["false", "-1"],
      ["true", "0"],
    ]);
  });
});
