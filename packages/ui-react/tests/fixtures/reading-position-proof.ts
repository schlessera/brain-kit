import { expect } from "bun:test";
import type { Page } from "playwright";

type Position = { anchor: string; offset: number };
type StoredContext = { sessionId: string | null; scroll: (Position & { fingerprint?: string }) | null };
type PartitionReader = {
  accountKey(): string | null;
  list(key: string): Promise<{ ok: true; value: Array<{ key: string; value: unknown }> } | { ok: false; error: string }>;
};

/** Independent checks of the actual scroller and a committed native partition read. */
export async function expectReadingPositionSaved(page: Page, position: Position, sessionId: string, scope: string) {
  const scroll = await page.locator("[data-reading-column]").evaluate(column => {
    const el = column.parentElement!;
    return { overflow: getComputedStyle(el).overflowY, top: el.scrollTop, remaining: el.scrollHeight - el.clientHeight - el.scrollTop };
  });
  expect(scroll.overflow, "the measured reading column belongs to the real scroller").toBe("auto");
  expect(scroll.top, "the actual scroller is away from the top").toBeGreaterThan(0);
  expect(scroll.remaining, "the actual scroller is away from the tail").toBeGreaterThan(20);
  expect(await page.getByRole("button", { name: "Scroll to latest", exact: true }).isVisible(), "the real scroll listener disabled tailing").toBe(true);

  const saved = await page.evaluate(() => {
    const f = (window as unknown as { __local: PartitionReader }).__local;
    return f.list(f.accountKey()!);
  });
  expect(saved.ok, "the committed account partition can be read").toBe(true);
  const contexts = saved.ok ? saved.value.filter(row => row.key === `${scope}/context` || row.key.startsWith(`${scope}/context/`)).map(row => row.value as StoredContext) : [];
  expect(contexts, "both tab-owned and shared native context records exist").toHaveLength(2);
  for (const context of contexts) {
    expect(context.sessionId, "the saved position belongs to this conversation").toBe(sessionId);
    expect(context.scroll, "the native context retains a non-null reading position").not.toBeNull();
    expect(context.scroll!.anchor, "the saved ordinal matches independently measured message geometry").toBe(position.anchor);
    expect(Math.abs(context.scroll!.offset - position.offset), "the saved offset matches within 1px").toBeLessThanOrEqual(1);
    expect(context.scroll!.fingerprint, "the saved anchor has content identity").toBeString();
    expect(context.scroll!.fingerprint!.length).toBeGreaterThan(0);
  }
}
