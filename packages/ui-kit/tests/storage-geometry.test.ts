import { describe, expect, test } from "bun:test";
import {
  isTileTarget,
  ownerCue,
  ownerEdge,
  shareFraction,
  storageRectangles,
  storageTargets,
  tileLabel,
} from "../src/storage/storage-geometry.js";

const area = (rects: { width: number; height: number }[]) => rects.reduce((sum, r) => sum + r.width * r.height, 0);

describe("storage map geometry (#4544)", () => {
  test("areas are proportional to bytes and fill the map exactly", () => {
    const items = [
      { id: "packs", bytes: 9_800 },
      { id: "models", bytes: 6_000 },
      { id: "logs", bytes: 4_100 },
      { id: "notes", bytes: 100 },
    ];
    const rects = storageRectangles(items, 480, 280);
    expect(rects.map((r) => r.item.id)).toEqual(["packs", "models", "logs", "notes"]);
    expect(area(rects)).toBeCloseTo(480 * 280, 6);
    for (const rect of rects) expect(rect.width * rect.height).toBeCloseTo((rect.item.bytes / 20_000) * 480 * 280, 6);
    for (const rect of rects) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(480 + 1e-9);
      expect(rect.y + rect.height).toBeLessThanOrEqual(280 + 1e-9);
    }
  });

  test("an unknown, zero or negative size never becomes a tile", () => {
    const rects = storageRectangles(
      [
        { id: "known", bytes: 10 },
        { id: "unknown", bytes: Number.NaN },
        { id: "infinite", bytes: Number.POSITIVE_INFINITY },
        { id: "zero", bytes: 0 },
        { id: "negative", bytes: -5 },
      ],
      100,
      100,
    );
    expect(rects.map((r) => r.item.id)).toEqual(["known"]);
    expect(storageRectangles([], 100, 100)).toEqual([]);
    expect(storageRectangles([{ id: "a", bytes: 1 }], 0, 100)).toEqual([]);
  });

  test("labels need 62 × 40, and a labelled tile always carries the owner letter", () => {
    expect(tileLabel(61.9, 200)).toBe("none");
    expect(tileLabel(200, 39.9)).toBe("none");
    expect(tileLabel(62, 40)).toBe("letter");
    expect(tileLabel(95.9, 40)).toBe("letter");
    expect(tileLabel(96, 40), "no word variant on a wide tile").toBe("letter");
    expect(tileLabel(1280, 800)).toBe("letter");
    expect(ownerCue("app", "letter")).toBe("A ·");
    expect(ownerCue("brain", "letter")).toBe("B ·");
    expect(ownerCue("operator", "letter")).toBe("O ·");
    expect(ownerCue("operator", "none")).toBe("");
  });

  test("targets need 44 × 44 and come in reading order", () => {
    expect(isTileTarget(44, 44)).toBe(true);
    expect(isTileTarget(43.9, 100)).toBe(false);
    expect(isTileTarget(100, 43.9)).toBe(false);
    expect(isTileTarget(100, 100, false)).toBe(false);
    const rects = storageRectangles(
      [
        { id: "a", bytes: 50 },
        { id: "b", bytes: 30 },
        { id: "c", bytes: 19.9 },
        { id: "tiny", bytes: 0.1 },
      ],
      300,
      200,
    );
    const targets = storageTargets(rects);
    expect(targets.map((t) => t.item.id)).not.toContain("tiny");
    for (let i = 1; i < targets.length; i++) {
      const [prev, next] = [targets[i - 1]!, targets[i]!];
      expect(prev.y < next.y || (prev.y === next.y && prev.x <= next.x)).toBe(true);
    }
    for (const t of targets) expect(t.width >= 44 && t.height >= 44).toBe(true);
  });

  test("each owner has its own edge, and the aggregate a neutral outline (no hatch exists)", () => {
    expect(ownerEdge("brain")).toEqual({ edge: "solid", width: 2, dash: null });
    expect(ownerEdge("app")).toEqual({ edge: "dotted", width: 2, dash: "2 2" });
    expect(ownerEdge("operator")).toEqual({ edge: "dashed", width: 2, dash: "6 3" });
    expect(ownerEdge(null)).toEqual({ edge: "outline", width: 1, dash: null });
    const patterns = new Set((["brain", "app", "operator", null] as const).map((o) => `${ownerEdge(o).width}/${ownerEdge(o).dash}`));
    expect(patterns.size).toBe(4);
  });

  test("a share bar clamps to 0–1 and draws nothing for a non-finite share", () => {
    expect(shareFraction(0.38)).toBe(0.38);
    expect(shareFraction(2)).toBe(1);
    expect(shareFraction(-1)).toBe(0);
    expect(shareFraction(Number.NaN)).toBe(0);
    expect(shareFraction(undefined)).toBe(0);
  });
});
