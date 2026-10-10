/** Imported file evidence in the pinned browser: line, endpoints, gaps and full text. */
import { page, commands } from "vitest/browser";
import { expect, test } from "vitest";
import * as track from "../../stories/blocks/TrackMap.stories.js";

interface Story { run: (context?: { globals?: Record<string, unknown> }) => Promise<void> }
for (const theme of ["dark", "light"]) {
  for (const [name, story] of [["phone-loop", track.Phone], ["desktop-loop", track.Wide], ["wide-plain", track.WidePlain], ["partial", track.Partial], ["polar", track.UnsupportedProjection]] as const) {
    test(`${name} ${theme}: complete file evidence and endpoints`, async () => {
      const before = { width: innerWidth, height: innerHeight };
      const width = name === "desktop-loop" ? 1440 : 390;
      const outer = await commands.formViewport(width, 1600);
      await page.viewport(width, 1600);
      try {
        await (story as unknown as Story).run({ globals: { theme } });
        const card = document.querySelector<HTMLElement>("[data-track-map]");
        expect(card).not.toBeNull();
        expect(card!.scrollWidth).toBeLessThanOrEqual(card!.clientWidth + 1);
        expect(card!.textContent).toContain("Original:");
        expect(card!.textContent).toContain("Moving time");
        expect(card!.textContent).toContain("Raft timber stand");
        if (name === "phone-loop" || name === "desktop-loop") {
          const line = card!.querySelector<SVGPolylineElement>("polyline");
          expect(line).not.toBeNull();
          expect(line!.points.numberOfItems).toBe(129);
          const box = line!.ownerSVGElement!.viewBox.baseVal;
          for (let i = 0; i < line!.points.numberOfItems; i++) {
            const point = line!.points.getItem(i);
            expect(point.x).toBeGreaterThan(0); expect(point.x).toBeLessThan(box.width);
            expect(point.y).toBeGreaterThan(0); expect(point.y).toBeLessThan(box.height);
          }
        }
        if (name !== "polar") {
          const lines = [...card!.querySelectorAll<SVGPolylineElement>("polyline")];
          expect(lines.length).toBeGreaterThan(0);
          const first = lines[0]!.points.getItem(0);
          const lastLine = lines.at(-1)!;
          const last = lastLine.points.getItem(lastLine.points.numberOfItems - 1);
          const svg = lines[0]!.ownerSVGElement!;
          const markers = [...card!.querySelectorAll<HTMLElement>("[data-track-marker]")];
          expect(markers.length).toBeGreaterThan(0);
          for (const marker of markers) {
            const endpoint = marker.dataset.trackMarker === "end" ? last : first;
            const point = svg.createSVGPoint(); point.x = endpoint.x; point.y = endpoint.y;
            const expected = point.matrixTransform(svg.getScreenCTM()!);
            const actual = marker.getBoundingClientRect();
            expect(Math.abs(actual.left + actual.width / 2 - expected.x), "endpoint x stays on the route").toBeLessThan(0.1);
            expect(Math.abs(actual.top + actual.height / 2 - expected.y), "endpoint y stays on the route").toBeLessThan(0.1);
          }
        }
        await expect(page.elementLocator(card!)).toMatchScreenshot(`track-${name}-${theme}`);
      } finally {
        await page.viewport(before.width, before.height);
        await commands.formViewport(outer.width - 100, outer.height - 120);
      }
    });
  }
}
