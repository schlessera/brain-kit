import { expect, test } from "vitest";
import { DESKTOP, button, effect, mount, palette, pointer, settle, tab, targets, walk, type Start, type Step } from "./navigation-reach-fixture.js";

/**
 * Parity: from the same start, the command's dedicated route and its palette
 * row end in the same effect. The palette row is pressed by pointer from 480
 * up. Below 480 there is no palette; the same actual pointer action at
 * 480 is the reference the phone route is compared with.
 */
const PHONE_PATHS: Record<string, Step[]> = {
  Chat: [tab("Chat")], Sessions: [tab("Sessions")], Actions: [tab("Actions")], Files: [tab("Files")],
  Settings: [tab("More"), button(/^Settings/)], Graph: [tab("More"), button(/^Graph/)],
  "New chat": [button("New chat")], Search: [button("Search the brain")],
  "Add a note": [tab("More"), button(/^Add a note/)], "Daily briefing": [tab("More"), button(/^Daily briefing/)],
  Sync: [tab("More"), button(/^Sync the brain/)], Stats: [tab("More"), button(/^Brain statistics/)],
};
for (const width of [320, 390, ...DESKTOP]) for (const [name, target] of Object.entries(targets)) {
  if (!target.palette) continue;
  const start: Start = name === "Chat" ? "actions" : "occupied";
  test(`parity at ${width}: ${name}'s route and its palette row do the same thing`, async (ctx) => {
    const mode = pointer();
    const theme = width % 2 ? "light" : "dark";
    const reference = await (async () => {
      const s = await mount(ctx, start, { width: Math.max(480, width), theme });
      s.writes.length = 0;
      await walk(s, palette(target.palette!), mode, `${name} by the visible palette`);
      await expect.poll(() => target.reached(s), { message: `${name} by the palette row` }).toBe(true);
      await settle(s);
      const reference = effect(s);
      // Native modals from the reference must close before another root is tested.
      s.dispose();
      return reference;
    })();
    const s = await mount(ctx, start, { width, theme });
    s.writes.length = 0;
    await walk(s, width < 480 ? PHONE_PATHS[name]! : target.path(start, width), mode, `${name} by its route`);
    await expect.poll(() => target.reached(s), { message: `${name} by its route` }).toBe(true);
    await settle(s);
    const routed = effect(s);
    // The pane takes focus from the rail and the palette alike; elsewhere focus is the route's own.
    expect({ ...routed, paneFocused: name === "Sessions" ? routed.paneFocused : null }, `${name}: route and palette agree`)
      .toEqual({ ...reference, paneFocused: name === "Sessions" ? reference.paneFocused : null });
  });
}
