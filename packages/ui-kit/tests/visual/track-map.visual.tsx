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
      // The image's unbundled mono fallback changes after other subjects run.
      // Reuse the receipt/form tests' conservative local face for these new
      // snapshots, then remove it without changing incumbent baselines.
      const face = new FontFace("JetBrains Mono", 'local("Liberation Mono"), local("LiberationMono")', { weight: "400 600" });
      try {
        document.fonts.add(await face.load());
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
        await expect(page.elementLocator(card!)).toMatchScreenshot(`track-${name}-${theme}`);
      } finally {
        document.fonts.delete(face);
        await page.viewport(before.width, before.height);
        await commands.formViewport(outer.width - 100, outer.height - 120);
      }
    });
  }
}
