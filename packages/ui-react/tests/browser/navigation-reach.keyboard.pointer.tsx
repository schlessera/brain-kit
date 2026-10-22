import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { DESKTOP, SURFACE, allCommands, mount, pointer, settle, targets } from "./navigation-reach-fixture.js";

/**
 * Keyboard alone, from 480 up: Tab reaches All commands, Enter opens the
 * palette with focus in its query, arrows reach each row and Enter runs it,
 * with the same effect a pointer gets. Esc from an opened palette returns
 * focus to All commands.
 */
for (const width of DESKTOP) for (const [name, target] of Object.entries(targets)) {
  if (!target.palette) continue;
  test(`keyboard only at ${width}: All commands → ${target.palette}`, async (ctx) => {
    pointer();
    const s = await mount(ctx, "occupied", { width, theme: width % 2 ? "light" : "dark" });
    s.writes.length = 0;
    const all = allCommands.find(s)!;
    (document.activeElement as HTMLElement | null)?.blur();
    // The rail's three stops: destinations, acts, All commands.
    for (let i = 0; i < 3; i++) await userEvent.tab();
    expect(document.activeElement, "Tab reaches All commands").toBe(all);
    await userEvent.keyboard("{Enter}");
    await settle(s);
    const dialog = () => s.host.querySelector<HTMLElement>('[role="dialog"][aria-label="Command palette"]');
    expect(dialog(), "Enter opens the palette").not.toBeNull();
    expect(document.activeElement, "focus enters the query").toBe(dialog()!.querySelector("input"));
    await userEvent.keyboard("{Escape}");
    await settle(s);
    expect(dialog()).toBeNull();
    expect(document.activeElement, "Esc returns focus to All commands").toBe(all);
    await userEvent.keyboard("{Enter}");
    await settle(s);
    const enabled = [...dialog()!.querySelectorAll<HTMLElement>('[role="option"]:not([aria-disabled="true"])')];
    const index = enabled.findIndex(row => (row.textContent ?? "").startsWith(target.palette!));
    expect(index, `${target.palette} is listed`).toBeGreaterThanOrEqual(0);
    await userEvent.keyboard("{ArrowDown}");
    for (let i = 0; i < index; i++) await userEvent.keyboard("{ArrowDown}");
    expect((document.activeElement?.textContent ?? "").startsWith(target.palette!), `arrows reach ${target.palette}`).toBe(true);
    await userEvent.keyboard("{Enter}");
    await settle(s);
    await expect.poll(() => target.reached(s), { message: `${name} by keyboard` }).toBe(true);
    await expect.poll(() => SURFACE[name]!(s), { message: `${name} is drawn after the keyboard route` }).toBe(true);
    expect(dialog(), "running a row closes the palette").toBeNull();
  });
}
