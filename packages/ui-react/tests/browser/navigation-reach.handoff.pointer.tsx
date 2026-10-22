import { expect, test } from "vitest";
import { DESKTOP, HANDOFF, ITHACA, PALETTE_ROWS, effect, find, handoffOpen, mountHandoff, palette, paletteRows, pointer, settle, tab, ui$, walk, wideAt, type Step } from "./navigation-reach-fixture.js";

for (const width of [320, 390, ...DESKTOP]) {
  test(`the conditional row at ${width}: ${HANDOFF} is listed for a stored session, and its row's overflow does what the palette row does`, async (ctx) => {
    const mode = pointer();
    const theme = width % 2 ? "light" : "dark";
    const reference = await (async () => {
      // At phone widths the parity reference intentionally mounts at 480:
      // the palette has no phone surface, so its first visible width is the reference.
      const s = await mountHandoff(ctx, Math.max(480, width), theme);
      ui$(s).setPaletteOpen(true);
      await settle(s);
      expect([...paletteRows(s)].sort(), "the palette lists the routed commands and the handoff").toEqual([...PALETTE_ROWS, HANDOFF].sort());
      ui$(s).setPaletteOpen(false);
      await settle(s);
      await walk(s, palette(HANDOFF), mode, `${HANDOFF} by the visible palette`);
      await expect.poll(() => handoffOpen(s), { message: `${HANDOFF} by the palette row` }).toBe(ITHACA.id);
      await settle(s);
      const reference = { ...effect(s), review: handoffOpen(s) };
      s.dispose();
      return reference;
    })();
    expect(reference.review, "the palette row opened a review").toBe(ITHACA.id);
    const s = await mountHandoff(ctx, width, theme);
    const overflow: Step = { name: `More for ${ITHACA.title}`, find: (x) => find(x, `More for ${ITHACA.title}`) };
    const item: Step = { name: HANDOFF, find: (x) => find(x, new RegExp(`^${HANDOFF}`), "menuitem") };
    await walk(s, [...(wideAt(width) ? [] : [tab("Sessions")]), overflow, item], mode, `${HANDOFF} by the row's overflow`);
    await expect.poll(() => handoffOpen(s), { message: `${HANDOFF} by the row's overflow` }).toBe(ITHACA.id);
    await settle(s);
    // The Sessions drawer the route went through is the only difference.
    const routed = { ...effect(s), review: handoffOpen(s) };
    expect({ ...routed, panels: routed.panels.filter((p) => p !== "sessionPanelOpen"), paneFocused: null },
      `${HANDOFF}: the overflow and the palette agree`).toEqual({ ...reference, panels: reference.panels.filter((p) => p !== "sessionPanelOpen"), paneFocused: null });
  });
}
