/** Pinned offline Chromium proof of the existing turn card/Disclosure/composer surfaces. */
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { useChatStore } from "../../src/stores/chat-store.js";
import { TurnJournal } from "../../src/components/chat/turn-journal.js";
import { Composer } from "../../src/components/chat/composer.js";
import type { ScopeCapReceipt, TurnJournalSummary } from "@schlessera/brain-ui-sdk/protocol";
import "../../../ui-kit/src/styles.css";
let ui: BrainUiRoot, renderer: Root, host: HTMLDivElement, styles: HTMLStyleElement;
const originalTheme = document.documentElement.dataset.theme, viewport = { width: innerWidth, height: innerHeight };
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());
afterEach(async () => { if (renderer) flushSync(() => renderer.unmount()); ui?.dispose(); host?.remove(); vi.unstubAllGlobals(); document.documentElement.style.zoom = "";
  if (originalTheme === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = originalTheme;
  await page.viewport(viewport.width, viewport.height); });
class Socket {
  static last: Socket; readyState = 0; onopen: (() => void) | null = null; onmessage: ((event: MessageEvent) => void) | null = null; onclose = null; onerror = null; sent: string[] = [];
  constructor() { Socket.last = this; } send(raw: string) { this.sent.push(raw); } close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(frame: object) { flushSync(() => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)); }
  decisions() { return this.sent.map(raw => JSON.parse(raw)).filter(frame => frame.type === "scope_decision"); }
}
const cap = (patch: Partial<ScopeCapReceipt> = {}): ScopeCapReceipt => ({ eventId: "athena-cap", dimension: "tool_calls", count: 503, cap: 500, overshoot: 3, newCap: 1000, observedAt: 1, frozen: true, state: "paused", ...patch });
const summary = (receipts: ScopeCapReceipt[] = [], actor: "interactive" | "voice" = "interactive"): TurnJournalSummary => ({ state: "recording", changedFiles: 7, steeringFiles: 0, costUsd: null, costIsEstimate: null, profile: "governed", actor, model: null, policyHash: null, sharedAttribution: false, observedAt: 1,
  scope: { policySource: "default", limits: { files_changed: 1000, tool_calls: 500, minutes: 120, turn_bytes: 4 * 1024 ** 3 }, hardTimeoutMs: 600000, calls: 503, minutes: 5, changedPaths: 7, observedBytes: 10000, coverage: "observed_versions", observedAt: 1, receipts } });
async function mount(width = 1280, theme: "dark" | "light" = "dark") {
  await page.viewport(width, 900); document.documentElement.dataset.theme = theme; vi.stubGlobal("WebSocket", Socket);
  ui = createBrainUiRoot({ storage: null, request: async input => {
    if (String(input).endsWith("/status")) return Response.json({ healthy: true, runtime: { boot: [], workerHost: { ordinary: { available: true, checkedAt: "2026-07-12T09:41:00.000Z", trigger: "boot" } } } });
    if (String(input).endsWith("/journal")) return Response.json({ turnId: "voyage", sessionId: "ithaca", summary: summary(), changes: [], missing: [] });
    return Response.json({ providers: [], sessions: [], backends: {} });
  } });
  ui.stores.chat.getState().setActiveSession("ithaca"); ui.stores.chat.getState().setMessages("ithaca", [{ id: "loom", role: "assistant", content: "Partial work remains.", parts: [{ kind: "text", text: "Partial work remains." }], timestamp: 1, isStreaming: true, toolCalls: [], turnId: "voyage", journal: summary() }]);
  function Scene() { const message = useChatStore(state => state.buffers.ithaca?.messages.at(-1)); return <main style={{ padding: 16, maxWidth: 900 }}>
    <p>Partial work remains.</p><TurnJournal turnId={message?.turnId} summary={message?.journal} live /><Composer send={message => ui.connection.send(message)} /></main>; }
  host = document.createElement("div"); host.style.cssText = "width:100%;min-width:0"; document.body.append(host); renderer = createRoot(host);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><Scene /></BrainUiProvider>));
  ui.connection.connect(); const socket = Socket.last; flushSync(() => socket.open()); socket.receive({ type: "server_hello", protocolRev: 5, capabilities: { chatRequestAck: true } });
  await document.fonts.ready;
  const field = host.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
  await userEvent.fill(field, "Ask Penelope about the shroud.");
  return { socket, field, frame(receipt: ScopeCapReceipt, actor?: "interactive" | "voice") { socket.receive({ type: "turn_journal", sessionId: "ithaca", turnId: "voyage", journal: summary([receipt], actor) }); } };
}
const option = (name: string) => [...host.querySelectorAll<HTMLElement>('[role="radio"]')].find(el => el.querySelector("b")?.textContent === name)!;
for (const width of [320, 1280]) for (const theme of ["dark", "light"] as const) test(`scope card numbers, finite Continue, input and native receipt focus: ${width} ${theme}`, async () => {
  const f = await mount(width, theme); const announcements: string[] = [];
  const observer = new MutationObserver(() => { const text = host.querySelector('[data-scope-event] [role="status"]')?.textContent; if (text && announcements.at(-1) !== text) announcements.push(text); }); observer.observe(host, { subtree: true, childList: true, characterData: true });
  f.field.focus(); f.frame(cap()); await expect.poll(() => option("Continue")).not.toBeUndefined();
  expect(document.activeElement, "SCOPE_BROWSER_ARRIVAL_NO_FOCUS_THEFT").toBe(f.field);
  expect(host.textContent).toContain("503 tool calls"); expect(host.textContent).toContain("500 tool calls"); expect(host.textContent).toContain("3 tool calls"); expect(host.textContent).toContain("exactly 1,000 tool calls");
  f.frame(cap()); expect(f.socket.decisions()).toEqual([]); await userEvent.keyboard("{Escape}"); expect(f.socket.decisions(), "SCOPE_ESCAPE_GRANTS_NOTHING").toEqual([]);
  for (const control of [option("Continue"), option("Stop here")]) expect(control.getBoundingClientRect().height, "SCOPE_EFFECTIVE_44PX_TARGET").toBeGreaterThanOrEqual(44);
  expect(document.documentElement.scrollWidth, "SCOPE_320_AND_DESKTOP_WRAP").toBeLessThanOrEqual(innerWidth);
  // Preserve the approved minimum 320 CSS-pixel content width at 200% zoom.
  await page.viewport(width * 2, 1800); document.documentElement.style.zoom = "2";
  expect(document.documentElement.scrollWidth, "SCOPE_200_PERCENT_ZOOM_WRAP").toBeLessThanOrEqual(document.documentElement.clientWidth);
  document.documentElement.style.zoom = ""; await page.viewport(width, 900);
  option("Continue").focus(); await userEvent.keyboard(" "); await expect.poll(() => f.socket.decisions().length).toBe(1);
  const sent = f.socket.decisions()[0]; expect(sent).toMatchObject({ eventId: "athena-cap", turnId: "voyage", sessionId: "ithaca", action: "continue" });
  expect(option("Continue").getAttribute("aria-disabled")).toBe("true"); expect(host.textContent).toContain("Waiting for the host's receipt");
  f.frame(cap({ state: "continued", submissionId: sent.submissionId }));
  await expect.poll(() => document.activeElement?.getAttribute("data-scope-receipt")).toBe("athena-cap");
  expect(host.textContent).toContain("continued · limit 1,000 tool calls for this turn"); expect(f.field.value, "SCOPE_UNSENT_COMPOSER_INPUT_RETAINED").toBe("Ask Penelope about the shroud.");
  expect(announcements.filter(text => text.startsWith("Turn paused")), "SCOPE_STATUS_ANNOUNCED_ONCE").toHaveLength(1); observer.disconnect();
  const disclosure = host.querySelector<HTMLElement>('[data-turn-journal] > div > [role="button"]')!;
  expect(disclosure.getAttribute("aria-expanded")).toBe("false"); disclosure.click(); await expect.poll(() => host.textContent).toContain("Observed versions in brain, scratch and workspaces");
  expect(host.textContent).toContain("Independent hard timeout: 10 min");
});
test("scope disconnected, manual readback/failure, answered elsewhere and session changes preserve authority and focus", async () => {
  const f = await mount(320); f.frame(cap()); option("Continue").focus(); await userEvent.keyboard(" "); const sent = f.socket.decisions()[0];
  flushSync(() => ui.stores.connection.getState().setWsStatus("disconnected")); expect(option("Continue").getAttribute("aria-disabled")).toBe("true"); expect(host.textContent).toContain("Needs the host to answer");
  flushSync(() => ui.stores.connection.getState().setWsStatus("connected")); expect(f.socket.decisions()).toHaveLength(1);
  const status = [...host.querySelectorAll<HTMLElement>('[role="button"]')].find(el => el.textContent?.includes("Check status"))!; status.click();
  expect(f.socket.decisions().at(-1)).toMatchObject({ action: "readback", submissionId: sent.submissionId });
  f.socket.receive({ ...sent, type: "scope_decision_receipt", state: "failed", reason: "Could not confirm the host action. Check status manually." });
  await expect.poll(() => host.textContent).toContain("Could not confirm"); expect(f.field.value).toBe("Ask Penelope about the shroud.");
  flushSync(() => ui.stores.chat.getState().setActiveSession("ogygia")); option("Continue").click(); expect(f.socket.decisions()).toHaveLength(2);
  expect(host.textContent).toContain("Open this chat to answer its limit");
  f.frame(cap({ state: "continued", submissionId: "another-device" })); expect(document.activeElement?.getAttribute("data-scope-receipt"), "SCOPE_OTHER_SESSION_RECEIPT_NEVER_TAKES_FOCUS").not.toBe("athena-cap");
  f.socket.receive({ ...sent, type: "scope_decision_receipt", state: "answered_elsewhere" }); expect(host.querySelector('[role="status"]')?.textContent).toBeDefined();
});
for (const stopOnly of ["floor", "second-hit"] as const) test(`${stopOnly}: Stop-only card ends at its receipt; Escape never stops`, async () => {
  const f = await mount(); const receipt = cap({ newCap: undefined, ...(stopOnly === "floor" ? { dimension: "free_space_floor", cap: 2147483648, count: 2000000000, overshoot: 147483648 } : { cap: 1000, count: 1001, overshoot: 1 }) });
  f.frame(receipt); expect(option("Continue")).toBeUndefined(); f.field.focus(); await userEvent.keyboard("{Escape}"); expect(f.socket.decisions()).toEqual([]);
  option("Stop here").focus(); await userEvent.keyboard(" "); const sent = f.socket.decisions()[0]; expect(sent.action).toBe("stop"); f.frame({ ...receipt, state: "stopped", submissionId: sent.submissionId });
  await expect.poll(() => document.activeElement?.getAttribute("data-scope-receipt")).toBe("athena-cap"); expect(f.field.value).toBe("Ask Penelope about the shroud.");
});
test("true voice exposes no grant card; ended-before-answer and incomplete coverage remain explicit", async () => {
  const f = await mount(); f.frame(cap({ state: "voice_stopped", newCap: undefined }), "voice"); expect(option("Continue")).toBeUndefined(); expect(option("Stop here")).toBeUndefined();
  f.frame(cap({ state: "ended_before_answer", newCap: undefined, reason: "Host restarted; the turn was interrupted." })); expect(host.textContent).toContain("turn ended before an answer"); expect(host.textContent).toContain("Host restarted");
  const unknown = summary([]); unknown.scope!.changedPaths = null; unknown.scope!.observedBytes = null; unknown.scope!.coverage = "partial";
  f.socket.receive({ type: "turn_journal", sessionId: "ithaca", turnId: "voyage", journal: unknown });
  const disclosure = host.querySelector<HTMLElement>('[data-turn-journal] > div > [role="button"]')!; disclosure.click(); await expect.poll(() => host.textContent).toContain("Incomplete observation; missing counts are unknown");
  expect(f.socket.decisions()).toEqual([]);
});

test("a floor reached during another pause leaves one Stop-only card and focuses the refused attempt's receipt", async () => {
  const f = await mount(320); f.frame(cap()); option("Continue").focus(); await userEvent.keyboard(" "); const sent = f.socket.decisions()[0];
  const floor = cap({ eventId: "disk-floor", dimension: "free_space_floor", count: 2000000000, cap: 2147483648, overshoot: 147483648, newCap: undefined });
  f.socket.receive({ type: "turn_journal", sessionId: "ithaca", turnId: "voyage", journal: summary([cap(), floor]) });
  f.socket.receive({ ...sent, type: "scope_decision_receipt", state: "refused", reason: "The free-space floor now requires Stop only." });
  await expect.poll(() => document.activeElement?.getAttribute("data-scope-receipt")).toBe("athena-cap");
  expect(option("Continue"), "SCOPE_SUPERSEDING_FLOOR_HAS_NO_CONTINUE").toBeUndefined();
  expect(host.querySelectorAll('[role="radio"]')).toHaveLength(1); expect(option("Stop here")).toBeDefined();
  expect(f.field.value).toBe("Ask Penelope about the shroud."); expect(f.socket.decisions()).toHaveLength(1);
});


test("budget warning and scope pause share one Disclosure without granting a budget override", async () => {
  const f = await mount(320); const combined = summary([cap()]);
  const observedAt = Date.UTC(2026, 6, 12, 9, 41);
  combined.budget = { listPriceCostUsd: 100, tokens: 1000, observedAt,
    coverage: "Built-in inference only; provider and tool spend is not metered",
    scopes: [{ scope: "turn", costUsd: 100, tokens: 1000, unknownRuns: 0,
      warnUsd: 100, blockUsd: 200, blockTokens: 512000000, warning: true, blocked: false }] };
  f.field.focus(); f.socket.receive({ type: "turn_journal", sessionId: "ithaca", turnId: "voyage", journal: combined });
  expect(document.activeElement, "COMBINED_LIMITS_ARRIVAL_PRESERVES_FOCUS").toBe(f.field);
  const disclosure = host.querySelector<HTMLElement>('[data-turn-journal] > div > [role="button"]')!;
  expect(disclosure.textContent).toContain("Budget warning");
  expect(host.querySelectorAll('[data-turn-journal] [aria-expanded]'), "COMBINED_LIMITS_ONE_DISCLOSURE").toHaveLength(1);
  disclosure.click(); await expect.poll(() => host.textContent).toContain("Completed-response list-price usage: $100.0000");
  expect(host.textContent).toContain("Scope limits"); expect(host.textContent).toContain("Ceilings: 500 calls");
  expect(host.textContent).toContain("stop $200");
  option("Continue").focus(); await userEvent.keyboard(" "); const sent = f.socket.decisions()[0];
  const continued = { ...combined, scope: { ...combined.scope!, limits: { ...combined.scope!.limits, tool_calls: 1000 },
    receipts: [cap({ state: "continued", submissionId: sent.submissionId })] } };
  f.socket.receive({ type: "turn_journal", sessionId: "ithaca", turnId: "voyage", journal: continued });
  await expect.poll(() => document.activeElement?.getAttribute("data-scope-receipt")).toBe("athena-cap");
  expect(host.textContent, "COMBINED_SCOPE_GRANT_DOES_NOT_RAISE_BUDGET").toContain("stop $200");
  expect(host.textContent).toContain("Budget warning"); expect(host.textContent).toContain("Ceilings: 1000 calls");
  expect(f.field.value).toBe("Ask Penelope about the shroud.");
});
