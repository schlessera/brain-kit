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
  interface BrowserCommands { dispatchActions(ordering: "two-confirmations" | "terminal-during-press"): Promise<any> }
}

test("two browser devices approve one autonomous decision and the change applies once", async () => {
  const r = await commands.dispatchActions("two-confirmations");
  expect(r.duringHold.resolutions, "BROWSER_HELD_FIRST_DECISION").toBe(0);
  expect(r.beforeRelease.resolutions, "BROWSER_TWO_DECISIONS_BEFORE_RESOLUTION").toBe(0);
  expect(r.decisions.map((d: { device: string }) => d.device), "BROWSER_TWO_OUTBOUND_DECISIONS").toEqual(["phone", "laptop"]);
  for (const d of r.decisions) expect(d.message).toMatchObject({ type: "inbox_resolve", itemId: r.before.actions[0].id, optionId: "apply" });
  for (const trace of r.traces) {
    expect(trace.filter((e: { event: string }) => e.event === "input:click"), "BROWSER_TRUSTED_CONFIRMATION").toEqual([{ event: "input:click", approval: true, trusted: true, target: true }]);
    expect(trace.filter((e: { event: string }) => e.event === "outbound:inbox_resolve")).toHaveLength(1);
  }
  expect(r.sequence.filter((event: string) => /native-click-complete|decision-forwarded/.test(event)), "NATIVE_CLICKS_FINISH_BEFORE_FORWARDING").toEqual([
    "phone:native-click-complete", "laptop:native-click-complete", "phone:decision-forwarded", "laptop:decision-forwarded",
  ]);
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

test("terminal replication during a native approval press does not count as a second confirmation", async () => {
  const r = await commands.dispatchActions("terminal-during-press");
  const trace = r.traces[1] as Array<{ event: string; approval: boolean; trusted?: boolean }>;
  const down = trace.findIndex(e => e.event === "input:pointerdown");
  const removed = trace.findIndex(e => e.event === "dom:approval-removed");
  const up = trace.findIndex(e => e.event === "input:pointerup");
  expect(trace[down], "NATIVE_PRESS_STARTED_ON_APPROVAL").toMatchObject({ approval: true, trusted: true, target: true });
  expect(removed, "TERMINAL_REMOVES_APPROVAL_DURING_PRESS").toBeGreaterThan(down);
  expect(trace.slice(down + 1, removed).some(e => e.event === "inbound:inbox_delta"), "TERMINAL_STREAM_BEFORE_DOM_REMOVAL").toBe(true);
  expect(trace.slice(removed + 1, up).some(e => e.event === "frame:after-approval-change" && !e.approval), "TERMINAL_PAINTED_BEFORE_RELEASE").toBe(true);
  expect(up).toBeGreaterThan(removed);
  expect(trace[up], "NATIVE_RELEASE_HAS_NO_APPROVAL_TARGET").toMatchObject({ approval: false, trusted: true, target: false });
  expect(trace.filter(e => e.event === "outbound:inbox_resolve"), "UNSENT_SECOND_PRESS_IS_NOT_CONFIRMATION").toEqual([]);
  expect(r.decisions.map((d: { device: string }) => d.device), "ONLY_ONE_OUTBOUND_DECISION").toEqual(["phone"]);
  expect(r.receipts[0]).toMatch(/Approved.*queued write_file/s);
  expect(r.receipts[1]).toMatch(/Resolved on another device/);
  expect(r.resolved.resolutions, "BROWSER_ONE_RESOLUTION").toBe(1);
  expect(r.resolved.executes, "BROWSER_ONE_FOLLOW_UP").toEqual(["ready"]);
  expect(r.after.note, "BROWSER_APPLIED_ONCE").toBe("Penelope keeps the loom until Odysseus returns.\n");
  expect(r.after.applied.map((a: { ok: boolean; code?: string }) => a.ok ? "applied" : a.code)).toEqual(["permission_denied", "applied"]);
  expect(r.diagnostics).toEqual([]);
}, 60_000);
