import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StorageMap, type StorageMapItem } from "../src/storage/StorageMap.js";

/**
 * Property sweep over map sizes and skews (#4559 review F1, F2): every tile
 * the map draws carries an edge in its owner's pattern with a nonzero
 * stroke, and an unlabelled tile has no padding that could grow it past its
 * computed box. The browser half (rendered rect == computed rect) is the
 * `Storage/StorageMap › Thin Tiles` story.
 */
const PATTERN: Record<string, (dash: number[]) => boolean> = {
  solid: (dash) => dash.length === 0,
  outline: (dash) => dash.length === 0,
  dotted: (dash) => dash.length === 2 && dash[0] === dash[1],
  dashed: (dash) => dash.length === 2 && dash[0]! > dash[1]!,
};
const EDGE_OF: Record<string, string> = { brain: "solid", app: "dotted", operator: "dashed", aggregate: "outline" };
const OWNERS = ["brain", "app", "operator"] as const;

function items(skew: number, count: number): StorageMapItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    name: `t${i}`,
    owner: OWNERS[i % 3]!,
    bytes: i === 0 ? skew : 1 + (i % 4),
    label: "x",
    smaller: i === count - 1 && count > 3,
  }));
}

describe("every storage tile keeps its owner edge and its computed box", () => {
  for (const [w, h] of [
    [296, 120],
    [296, 185],
    [160, 100],
    [616, 462],
  ])
    for (const skew of [1, 20, 98, 400, 5000])
      for (const count of [2, 3, 6, 12])
        test(`${w} x ${h}, skew ${skew}, ${count} tiles`, () => {
          const html = renderToStaticMarkup(
            <StorageMap items={items(skew, count)} width={w} height={h} label="Storage map" descriptionId="d" onOpen={() => {}} onUp={() => {}} />,
          );
          const tiles = html.split(/(?=<(?:button|div) [^>]*class="bk-storage-tile")/).slice(1);
          expect(tiles.length).toBe(count);
          for (const tile of tiles) {
            const owner = /data-owner="([a-z]+)"/.exec(tile)![1]!;
            const label = /data-label="([a-z]+)"/.exec(tile)![1]!;
            const edge = /<svg[^>]*data-edge="([a-z]+)"/.exec(tile);
            expect(edge?.[1], `STORAGE_EVERY_TILE_HAS_AN_EDGE (${owner}, ${label})`).toBe(EDGE_OF[owner]);
            const mark = /<(rect|line) ([^>]*)>/.exec(tile.slice(tile.indexOf("<svg")))!;
            expect(Number(/stroke-width="([\d.]+)"/.exec(mark[2]!)?.[1])).toBeGreaterThan(0);
            const dash = (/stroke-dasharray="([^"]*)"/.exec(mark[2]!)?.[1] ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
            expect(PATTERN[edge![1]!]!(dash), `${owner} pattern from "${dash.join(" ")}"`).toBe(true);
            if (label === "none") expect(tile, "STORAGE_UNLABELLED_TILE_HAS_NO_PADDING").toMatch(/^<[^>]*style="[^"]*padding:0[;"]/);
          }
        });
});
