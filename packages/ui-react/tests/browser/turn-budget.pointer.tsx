/// <reference types="@vitest/browser-playwright" />
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeAll, afterAll, expect, test, vi } from "vitest";
import { page, userEvent, commands } from "vitest/browser";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import type { TurnBudgetReceipt, TurnJournalSummary } from "@schlessera/brain-ui-sdk/protocol";
import "../../../ui-kit/src/styles.css";
let ui: BrainUiRoot | undefined, renderer: Root | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement;
const theme = document.documentElement.dataset.theme;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());
afterEach(() => { if (renderer)
  flushSync(() => renderer!.unmount()); ui?.dispose(); host?.remove(); renderer = undefined; ui = undefined; host = undefined; vi.unstubAllGlobals(); if (theme === undefined)
  delete document.documentElement.dataset.theme;
else
  document.documentElement.dataset.theme = theme; });
class BudgetSocket {
  static last: BudgetSocket;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose = null;
  onerror = null;
  constructor() { BudgetSocket.last = this; }
  send() { }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(frame: object) { flushSync(() => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)); }
}
const budget = (warning = true, unknown = false): TurnBudgetReceipt => ({ listPriceCostUsd: unknown ? null : 100, tokens: 1000, observedAt: Date.UTC(2026, 6, 12, 9, 41),
  coverage: "Built-in inference only; provider and tool spend is not metered", scopes: (["turn", "session", "day"] as const).map(scope => ({ scope, costUsd: unknown ? null : 100, tokens: 1000, unknownRuns: unknown ? 1 : 0,
    warnUsd: scope === "turn" ? 100 : 2000, blockUsd: scope === "turn" ? 200 : 4000, blockTokens: scope === "turn" ? 512000000 : 8000000000,
    warning: warning && scope === "turn", blocked: false, ...(scope === "day" ? { resetAt: Date.UTC(2026, 6, 13) } : {}) })) });
const summary = (receipt: TurnBudgetReceipt): TurnJournalSummary => ({ state: "complete", changedFiles: 1, steeringFiles: 0, costUsd: null, costIsEstimate: null, profile: "governed", actor: "interactive", model: null, policyHash: null, sharedAttribution: false, observedAt: receipt.observedAt, budget: receipt });
async function mount(width: number, paper = false) {
  await page.viewport(width, width === 640 ? 400 : 800);
  document.documentElement.dataset.theme = paper ? "light" : "dark";
  vi.stubGlobal("WebSocket", BudgetSocket);
  const request = async (input: string) => {
    const path = new URL(input, "http://fixture.invalid").pathname;
    if (path.endsWith("/providers"))
      return Response.json({ providers: [{ id: "claude", label: "Ithaca model", backendId: "claude" }], backends: { claude: { id: "claude", capabilities: { concurrentSessions: true, followUp: false } } } });
    if (path.endsWith("/journal"))
      return Response.json({ turnId: "voyage", sessionId: "ithaca", summary: summary(budget()), changes: [], missing: [] });
    if (path.endsWith("/sessions"))
      return Response.json({ sessions: [] });
    if (path.endsWith("/profile"))
      return Response.json({ preference: "governed", policyProfile: "governed", policyHash: null, origin: "interactive", limits: [{ name: "Turn inference", value: "Warn $100; stop $200" }] });
    return Response.json({});
  };
  ui = createBrainUiRoot({ storage: null, request });
  ui.stores.provider.setState({ available: [{ id: "claude", label: "Ithaca model", backendId: "claude" }], pinnedId: "claude", loaded: true });
  ui.stores.chat.getState().setActiveSession("ithaca");
  ui.stores.chat.getState().setSessionBackend("ithaca", "claude");
  ui.stores.chat.getState().setMessages("ithaca", [{ id: "voyage", role: "assistant", content: "Athena recorded partial work.", parts: [{ kind: "text", text: "Athena recorded partial work." }], toolCalls: [], timestamp: 1, isStreaming: false, turnId: "voyage" }]);
  host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0";
  document.body.append(host);
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<BrainUiProvider root={ui!}><AppShell><ChatPage /></AppShell></BrainUiProvider>));
  ui.connection.connect();
  const socket = BudgetSocket.last;
  flushSync(() => socket.open());
  socket.receive({ type: "server_hello", protocolRev: 5, principalKey: "athena-device", capabilities: { sessionProfiles: true, chatRequestAck: true } });
  await document.fonts.ready;
  return socket;
}
for (const [width, paper] of [[320, false], [1280, true], [640, false], [640, true]] as const)
  test(`one budget warning disclosure preserves focus, unknown prices and unsent input ${width}`, async () => {
    const socket = await mount(width, paper), receipt = budget();
    socket.receive({ type: "turn_journal", sessionId: "ithaca", turnId: "voyage", journal: summary(receipt) });
    await expect.poll(() => host!.textContent).toContain("Budget warning");
    expect(host!.querySelectorAll('[data-turn-journal="voyage"]').length, "BUDGET_SINGLE_SHARED_DISCLOSURE").toBe(1);
    socket.receive({ type: "usage", sessionId: "ithaca", turnId: "voyage", observedAt: receipt.observedAt, usage: { inputTokens: 1000 }, budget: receipt });
    expect(ui!.stores.chat.getState().buffers["ithaca"]!.isStreaming, "BUDGET_USAGE_NEVER_REOPENS_TURN").toBe(false);
    const field = host!.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
    await userEvent.fill(field, "Ask Penelope about the shroud.");
    const opener = host!.querySelector<HTMLElement>('[data-turn-journal] button,[data-turn-journal] [role="button"]')!;
    opener.focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => host!.textContent).toContain("This is not a subscription invoice");
    expect(opener.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(host!.textContent).toContain("Unpriced token stop: 512,000,000");
    expect(host!.textContent).toContain("2026-07-13T00:00:00.000Z");
    expect(document.documentElement.scrollWidth, "BUDGET_NO_HORIZONTAL_OVERFLOW").toBeLessThanOrEqual(innerWidth);
    socket.receive({ type: "turn_journal", sessionId: "harbor", turnId: "voyage", journal: summary(budget(false, true)) });
    expect(host!.textContent).toContain("Budget warning");
    socket.receive({ type: "turn_journal", sessionId: "ithaca", turnId: "voyage", journal: summary(budget(false, true)) });
    await expect.poll(() => host!.textContent).toContain("Completed-response list-price usage: unknown");
    expect(host!.textContent).not.toContain("$0.0000");
    expect(document.activeElement).toBe(opener);
    expect(field.value).toBe("Ask Penelope about the shroud.");
  });
for (const scope of ["session", "day"] as const)
  test(`${scope} budget refusal preserves partial work and offers only its reviewed continuation`, async () => {
    const socket = await mount(320);
    socket.receive({ type: "error", code: "BUDGET_EXCEEDED", sessionId: "ithaca", turnId: "voyage", failure: { errorClass: "budget_exceeded", budgetScope: scope, message: scope === "session" ? "Review the partial work and start a new conversation; the day balance still applies." : "The UTC day resets at 2026-07-13T00:00:00.000Z.", ...(scope === "day" ? { resetsAt: Date.UTC(2026, 6, 13) } : {}) }, message: "Inference budget reached." });
    await expect.poll(() => host!.querySelector('[data-turn-failure="budget_exceeded"]')).not.toBeNull();
    expect(host!.textContent).toContain("Athena recorded partial work.");
    expect(host!.querySelector('[data-turn-failure]')!.textContent).not.toContain("Retry");
    const action = page.getByRole("button", { name: "Continue in a new conversation", exact: true });
    if (scope === "session") {
      await expect.element(action).toBeVisible();
      await action.click();
      await expect.poll(() => ui!.stores.handoff.getState().sheet?.sourceSessionId).toBe("ithaca");
      await expect.element(page.getByRole("dialog")).toBeVisible();
    }
    else
      expect(host!.textContent).not.toContain("Continue in a new conversation");
  });
test("usage before a journal and delayed empty-budget receipts/history preserve fresh warning evidence without reopening or stealing focus", async () => {
  const socket = await mount(320), receipt = budget(), field = host!.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
  await userEvent.fill(field, "Ask Penelope about the shroud.");
  field.focus();
  socket.receive({ type: "usage", sessionId: "ithaca", turnId: "voyage", usage: { inputTokens: 1000 }, observedAt: receipt.observedAt, budget: receipt });
  await expect.poll(() => host!.textContent).toContain("Budget warning");
  expect(document.activeElement, "BUDGET_WARNING_DOES_NOT_STEAL_COMPOSER_FOCUS").toBe(field);
  const { budget: ignored, ...oldJournal } = summary(receipt);
  void ignored;
  socket.receive({ type: "turn_journal", sessionId: "ithaca", turnId: "voyage", journal: oldJournal });
  expect(host!.textContent, "BUDGET_DELAYED_JOURNAL_CANNOT_CLEAR_WARNING").toContain("Budget warning");
  socket.receive({ type: "session_history", sessionId: "ithaca", messages: [{ role: "assistant", content: "Athena recorded partial work.", toolCalls: [], turnId: "voyage", journal: oldJournal }] });
  await expect.poll(() => host!.textContent).toContain("Budget warning");
  socket.receive({ type: "usage", sessionId: "ithaca", turnId: "voyage", usage: { inputTokens: 1 }, observedAt: receipt.observedAt - 1, budget: { ...budget(false, true), observedAt: receipt.observedAt - 1 } });
  await expect.poll(() => host!.textContent).toContain("Budget warning");
  expect(field.value).toBe("Ask Penelope about the shroud.");
  expect(ui!.stores.chat.getState().buffers["ithaca"]!.isStreaming).toBe(false);
});
test("voice warnings stay visual in the same receipt and grant no continuation", async () => {
  const socket = await mount(320), receipt = budget();
  socket.receive({ type: "turn_journal", sessionId: "ithaca", turnId: "voyage", journal: { ...summary(receipt), actor: "voice" } });
  await expect.poll(() => host!.textContent).toContain("Budget warning");
  expect(host!.querySelector('[data-turn-journal] [role="status"]')?.textContent ?? "", "BUDGET_VOICE_WARNING_NOT_ANNOUNCED").not.toContain("warning");
  expect(host!.textContent).not.toContain("Continue in a new conversation");
});
