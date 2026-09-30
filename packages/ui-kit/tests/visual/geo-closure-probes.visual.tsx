/** Chromium checks the actual SVG fill, complementing the offline coordinate gate. */
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import raw from "../../fixtures/geo/closure-probes.json" with { type: "json" };
import { geo, type GeoId } from "../../fixtures/geo/index.js";
import { MapView } from "../../src/blocks/MapView.js";

type Point = [number, number];
type Rings = Point[][];
let host: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

function painted(id: GeoId, rings: Rings, points: Point[]): boolean[] {
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  const { center: [lon, lat], spanKm } = geo[id];
  flushSync(() => root!.render(<MapView
    width={330} height={220} spanKm={spanKm} pins={[{ lon, lat }]}
    land={{ rings }} paths={points.map((p) => ({ coords: [p, p] }))}
  />));
  const paths = host.querySelectorAll<SVGPathElement>('path[fill-rule="evenodd"]');
  expect(paths).toHaveLength(rings.length ? 1 : 0);
  const probes = [...host.querySelectorAll<SVGPolylineElement>("polyline")];
  expect(probes).toHaveLength(points.length);
  return probes.map((probe) => {
    const position = probe.points.getItem(0);
    return paths[0]?.isPointInFill(new DOMPoint(position.x, position.y)) ?? false;
  });
}

function contains(ring: Point[], point: Point): boolean {
  const path = new Path2D(`M${ring.map((p) => p.join(",")).join("L")}Z`);
  const context = document.createElement("canvas").getContext("2d")!;
  return context.isPointInPath(path, point[0], point[1], "evenodd");
}

describe("every independently sourced closure in Chromium", () => {
  for (const c of raw.closures) {
    const id = c.fixture as GeoId;
    const points = [c.land.point, c.sea.point] as Point[];
    const name = `${id}/${c.id}`;

    test(`${name}: expected land is painted and sea is clear`, () => {
      expect(painted(id, geo[id].land, points), `${name}: expected [land, sea]`).toEqual([true, false]);
    });

    test(`${name}: deleting the closure loses its land witness`, () => {
      const target = geo[id].land.find((r) => contains(r, points[0]!));
      expect(target, `${name}: mutation has an observed target`).toBeDefined();
      expect(painted(id, geo[id].land.filter((r) => r !== target), points), `${name}: deletion loses land`).toEqual([false, false]);
    });

    test(`${name}: wrong-side replacement clears land and paints sea`, () => {
      const target = geo[id].land.find((r) => contains(r, points[0]!));
      expect(target, `${name}: mutation has an observed target`).toBeDefined();
      const { center: [lon, lat], spanKm } = geo[id];
      const dx = spanKm * 0.75 / 111 / Math.cos(lat * Math.PI / 180);
      const dy = spanKm / 222;
      const viewport: Point[] = [
        [lon - dx, lat - dy], [lon + dx, lat - dy], [lon + dx, lat + dy],
        [lon - dx, lat + dy], [lon - dx, lat - dy],
      ];
      const changed = [...geo[id].land.filter((r) => r !== target), viewport, target!];
      expect(painted(id, changed, points), `${name}: wrong side flips [land, sea]`).toEqual([false, true]);
    });
  }
});
