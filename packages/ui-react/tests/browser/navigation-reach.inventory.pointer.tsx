import { expect, test } from "vitest";
import { DESKTOP, PALETTE_ROWS, mount, paletteRows, pointer, settle, ui$ } from "./navigation-reach-fixture.js";

for (const width of [320, 390, ...DESKTOP]) for (const theme of ["dark", "light"] as const) {
  test(width < 480 ? `inventory at ${width} (${theme}): no phone palette, including programmatic opening`
    : `inventory at ${width} (${theme}): the palette's rows are exactly the commands routed here`, async (ctx) => {
    pointer();
    const s = await mount(ctx, "occupied", { width, theme });
    ui$(s).setPaletteOpen(true);
    await settle(s);
    if (width < 480) {
      expect(ui$(s).paletteOpen, "phone guard clears programmatic opening").toBe(false);
      expect(s.host.querySelector('[data-palette]'), "no hidden modal below 480").toBeNull();
      return;
    }
    const rows = paletteRows(s);
    expect([...rows].sort(), `the palette at ${width} lists the routed commands`).toEqual([...PALETTE_ROWS].sort());
    expect(rows.filter((r) => r === "Sessions"), "Sessions once").toHaveLength(1);
  });
}
