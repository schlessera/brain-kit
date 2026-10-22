import { expect, test } from "vitest";
import { DESKTOP, PALETTE_ROWS, allCommands, mount, pointer, rect, settle, walk } from "./navigation-reach-fixture.js";

/**
 * The palette's rows are the only pointer route to Graph, Sync and Stats
 * (D52 §1), so under a coarse pointer each must be a 44px target (D20), and
 * the row's own box must take a press at each of its four inset corners:
 * the rows sit 2px apart, so a neighbour's reach would show up there. Under
 * a fine pointer the rows keep their 34px density (35.7px with a chip)
 * (#1120).
 */
for (const width of DESKTOP) for (const theme of ["dark", "light"] as const) {
  test(`palette rows at ${width} (${theme}): 44px targets under a coarse pointer, mouse density under a fine one`, async (ctx) => {
    const mode = pointer();
    const s = await mount(ctx, "occupied", { width, theme });
    await walk(s, [allCommands], mode, "the palette");
    const rows = [...s.host.querySelectorAll<HTMLElement>('[role="dialog"][aria-label="Command palette"] [role="option"]')];
    expect(rows.length, "the palette lists its rows").toBe(PALETTE_ROWS.length);
    for (const row of rows) {
      // The list scrolls on a short palette, as a thumb would scroll it.
      row.scrollIntoView({ block: "nearest" });
      await settle(s, 1);
      const r = rect(row);
      const name = row.textContent ?? "";
      for (const [x, y] of [[r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1]] as const) {
        const hit = document.elementFromPoint(x, y);
        expect(row.contains(hit), `the row's own box takes a press at ${x},${y}: ${name} hit ${hit?.outerHTML.slice(0, 120)}`).toBe(true);
      }
      if (mode === "fine") {
        expect(Math.round(r.height * 10) / 10, `fine-pointer density: ${name}`).toBe(/sync|spends/.test(name) ? 35.7 : 34);
      } else {
        expect(r.height, `44px target height: ${name}`).toBeGreaterThanOrEqual(43.5);
        expect(r.width, `44px target width: ${name}`).toBeGreaterThanOrEqual(43.5);
      }
    }
  });
}
