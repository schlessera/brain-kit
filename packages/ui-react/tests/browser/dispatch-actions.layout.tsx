/**
 * #689 AC1: browser-driven resolution of an autonomous decision. The real app
 * (fixture host, gated production dispatcher) escalates a queued arrival; two
 * real Chromium pages render the real Actions page over the app's WebSocket
 * and both tap Approve. One resolution and one follow-up result, and the
 * next cron poke applies the exact change once.
 */
import { expect, test } from "vitest";
import { commands } from "vitest/browser";

declare module "vitest/browser" {
  interface BrowserCommands { dispatchActions(): Promise<any> }
}

test("two browser devices approve one autonomous decision and the change applies once", async () => {
  const r = await commands.dispatchActions();
  expect(r.escalated).toMatchObject({ claimed: 1, dispatchEnabled: true });
  expect(r.before.actions).toEqual([expect.objectContaining({ status: "pending" })]);
  expect(r.before.note).toBeNull();
  expect(r.resolved.resolutions, "BROWSER_ONE_RESOLUTION").toBe(1);
  expect(r.resolved.executes, "BROWSER_ONE_FOLLOW_UP").toEqual(["ready"]);
  expect(r.resolved.actions).toEqual([expect.objectContaining({ status: "resolved" })]);
  for (const text of r.receipts) expect(text, "BROWSER_RECEIPT: each device shows its own exact approval").toMatch(/Approved\s*·?\s*queued write_file → notes\/ithaca-loom\.md/);
  expect(r.applied).toMatchObject({ claimed: 1 });
  expect(r.after.executes).toEqual(["done"]);
  expect(r.after.note, "BROWSER_APPLIED_ONCE").toBe("Penelope keeps the loom until Odysseus returns.\n");
  expect(r.after.applied.map((a: { ok: boolean; code?: string }) => a.ok ? "applied" : a.code)).toEqual(["permission_denied", "applied"]);
  expect(r.diagnostics).toEqual([]);
}, 60_000);
