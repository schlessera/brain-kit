import { AgentPolicyGroup } from "../../src/components/settings/agent-policy-group.js";
import { useShallow } from "zustand/react/shallow";
/// <reference types="@vitest/browser-playwright" />
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { activeChat, useChatStore } from "../../src/stores/chat-store.js";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { replyToToolApproval } from "../../src/lib/tool-approval.js";
import { parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
let fixture: { id: string; url: string } | undefined, ui: BrainUiRoot | undefined, socket: WebSocket | undefined, renderer: Root | undefined, host: HTMLDivElement | undefined;
let styles: HTMLStyleElement;
let observer: MutationObserver | undefined;
const timeline: Array<Record<string, unknown>> = [];
let sceneStarted = 0;
function record(stage: string, detail: Record<string, unknown> = {}) {
  if (timeline.length === 128) timeline.shift();
  timeline.push({ stage, ms: performance.now() - sceneStarted, session: ui?.stores.chat.getState().activeSessionId,
    epoch: ui?.authLock.epoch(), ...detail });
}
const approvalSelector = '[data-policy-change] [data-kit-approval-actions] [role="button"]';
const viewport = { width: innerWidth, height: innerHeight }, themeBefore = document.documentElement.dataset.theme;
const sent: ClientMessage[] = [];
const received: unknown[] = [];
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(async () => { styles.remove(); await page.viewport(viewport.width, viewport.height); });
afterEach(async () => { observer?.disconnect(); observer = undefined; if (renderer) flushSync(() => renderer!.unmount()); renderer = undefined; ui?.dispose(); ui = undefined; socket?.close(); socket = undefined; host?.remove(); host = undefined;
  if (fixture) await commands.policyServer({ op: "stop", id: fixture.id }); fixture = undefined; sent.length = 0; received.length = 0;
  if (themeBefore === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = themeBefore;
});
const patch = (value: Record<string, unknown> = {}) => commands.policyServer({ op: "set", id: fixture!.id, patch: value }) as Promise<{ bytes: string; original: string; proposed: string; writes: number; reads: number; receiptTimeline: Array<{ stage: string; ms: number; requestId: number; method: string; path: string; status?: number; principal: string }>; policy: { hash: string }; journalChanges: Array<{path: string;actor:string;class:string}>; journalPolicies: Array<{policy_hash:string|null}>; admitted: Array<{hash: string | null}>; events: Array<{actor:string;kind:string}> }>;
async function scene(width = 320, theme = "dark", zoom = 1, mode = "", rejectReceipt = false) {
  timeline.length = 0; sceneStarted = performance.now(); record("scene", { width, theme, zoom, mode });
  await page.viewport(width, 1000); document.documentElement.dataset.theme = theme;
  fixture = await commands.policyServer({ op: "start" }) as typeof fixture; await patch({ mode });
  ui = createBrainUiRoot({ storage: null, config: { backendUrl: fixture!.url }, request: (url, init) => {
    if (!String(url).includes("/policy-proposals/")) return fetch(url, init);
    record("receipt-dispatch", { path: new URL(url).pathname, aborted: init?.signal?.aborted ?? false });
    const aborted = () => record("receipt-abort");
    init?.signal?.addEventListener("abort", aborted, { once: true });
    const result = rejectReceipt ? Promise.reject<Response>(new Error("Controlled receipt transport failure")) : fetch(url, init);
    // Observe settlement without replacing the native fetch promise returned to the client.
    const cleanup = () => init?.signal?.removeEventListener("abort", aborted);
    void result.then(
      response => { record("receipt-response", { status: response.status }); cleanup(); },
      error => { record("receipt-error", { error: String(error) }); cleanup(); },
    ).catch(() => { cleanup(); });
    return result;
  } });
  socket = new WebSocket(fixture!.url.replace("http:", "ws:") + "/ws");
  ui.connection.send = message => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    if (message.type === "tool_approval" || message.type === "tool_denial") {
      const toolUseId = message.toolUseId;
      const tool = activeChat(ui!.stores.chat.getState()).messages.flatMap(m => m.toolCalls).find(t => t.id === toolUseId);
      message = { ...message, turnId: tool?.policyChange?.turnId };
    }
    sent.push(message); socket.send(JSON.stringify(message)); return true;
  };
  socket.onmessage = event => { const frame = JSON.parse(event.data); record("frame", { type: frame.type, sessionId: frame.sessionId }); received.push(frame); const parsed = parseServerMessage(event.data); if (!parsed.ok) throw new Error(parsed.error); ui!.connection.handleServerMessage(parsed.message); };
  await expect.poll(() => socket!.readyState).toBe(WebSocket.OPEN);
  ui.stores.chat.setState({ activeSessionId: "policy-session" });
  ui.stores.chat.getState().addUserMessage("policy-session", "Propose strict for the voyage.", "voice-dictate");
  ui.stores.chat.getState().startAssistantMessage("policy-session");
  function View() {
    const calls = useChatStore(useShallow(s => activeChat(s).messages.flatMap(m => m.toolCalls)));
    return <><textarea data-composer aria-label="Message" style={{ width: "100%", boxSizing: "border-box" }} /><ToolCallTimeline live toolCalls={calls}
      onApproval={(id, allow, always) => replyToToolApproval(ui!, ui!.stores.chat.getState().activeSessionId, ui!.connection.send, id, allow, always)} /></>;
  }
  host = document.createElement("div"); host.style.cssText = `width:${Math.min(720, width / zoom)}px;zoom:${zoom};background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
  document.body.append(host); renderer = createRoot(host); flushSync(() => renderer!.render(<BrainUiProvider root={ui}><View /></BrainUiProvider>));
  host.querySelector<HTMLTextAreaElement>("textarea")!.focus();
  let lastDom = "";
  // DOM delivery is observed after mutation; it is not the React passive-effect boundary.
  observer = new MutationObserver(() => {
    const card = host?.querySelector("[data-policy-change]");
    const state = card?.getAttribute("data-policy-state") ?? null;
    const actionable = !!host?.querySelector(approvalSelector);
    const snapshot = JSON.stringify({ state, actionable, text: card?.textContent ?? null });
    if (snapshot !== lastDom) { lastDom = snapshot; record("dom", { state, actionable }); }
  });
  observer.observe(host, { childList: true, subtree: true, attributes: true, characterData: true });
  record("chat-send");
  ui.connection.send({ type: "chat_message", text: "Propose strict for the voyage.", source: "voice-dictate" });
  if (mode !== "bad-proposal") {
    try { await expect.poll(() => host!.querySelector(approvalSelector)).not.toBeNull(); }
    catch (error) { record("readiness-failed"); throw new Error(`${String(error)}\nTimeline (browser milliseconds from scene start): ${JSON.stringify(timeline)}\nFrames: ${JSON.stringify(received)}\nFixture: ${JSON.stringify(await patch())}\nChat: ${JSON.stringify(activeChat(ui.stores.chat.getState()).messages)}\nDOM: ${host.textContent}`); }
  }
  return host;
}
for (const width of [320, 1280]) for (const theme of ["dark", "light"]) for (const zoom of [1, 2]) test(`${theme} ${width} ${zoom * 100}%: policy diff, focus and approved bytes`, async () => {
  const host = await scene(width, theme, zoom);
  expect(document.activeElement).toBe(host.querySelector("textarea"));
  expect(host.textContent).toContain("profiles.interactive"); expect(host.textContent).toContain("Body text changed."); expect(host.textContent).toContain("Agent rationale");
  expect(host.textContent).not.toMatch(/Loosens|Tightens|Always allow/);
  await page.getByRole("button", { name: "Read full policy diff", exact: true }).click();
  await expect.poll(() => document.activeElement?.textContent).toBe("Review the exact policy changes");
  await userEvent.keyboard("{Escape}"); await expect.poll(() => document.activeElement?.textContent).toBe("Read full policy diff");
  const approve = page.getByRole("button", { name: "Approve and write", exact: true });
  const controls = [...host.querySelectorAll<HTMLElement>('[data-kit-approval-actions] [role="button"]')];
  for (const control of controls) { expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44); expect(control.getBoundingClientRect().width).toBeGreaterThanOrEqual(44); }
  expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
  await approve.click(); await expect.poll(() => host.querySelector('[data-policy-state="updated"]')).not.toBeNull();
  await expect.poll(() => document.activeElement).toBe(host.querySelector("[data-policy-receipt]"));
  const receipt = await patch(); expect(receipt.bytes).toBe(receipt.proposed); expect(receipt.writes).toBe(1); expect(receipt.policy.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.receiptTimeline).toEqual([
    expect.objectContaining({ stage: "request", requestId: 1, method: "GET", path: expect.stringContaining("/api/policy-proposals/"), ms: expect.any(Number), principal: expect.any(String) }),
    expect.objectContaining({ stage: "response", requestId: 1, status: 200, ms: expect.any(Number) }),
  ]);
  const [request, response] = receipt.receiptTimeline;
  expect(response).toMatchObject({ requestId: request!.requestId, method: request!.method, path: request!.path, principal: request!.principal });
  expect(receipt.events).toEqual([expect.objectContaining({ actor: "user", kind: "policy_change" })]);
  expect(receipt.journalChanges).toContainEqual({ path: "context/policies/governance.md", actor: "user", class: "policy" });
  socket!.send(JSON.stringify({ type: "chat_message", sessionId: "policy-session", text: "Read the current policy." }));
  await expect.poll(async () => (await patch()).admitted.length).toBe(2);
  const next = await patch(); expect(next.admitted.at(-1)?.hash).toBe(receipt.policy.hash); expect(next.journalPolicies.at(-1)?.policy_hash).toBe(receipt.policy.hash);
  expect(sent.filter(message => message.type === "tool_approval")).toHaveLength(1);
});
test("decline leaves exact bytes and its receipt in the same turn", async () => {
  const host = await scene(); await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect.poll(() => host.querySelector('[data-policy-state="declined"]')).not.toBeNull(); const r = await patch(); expect(r.bytes).toBe(r.original); expect(r.writes).toBe(0);
  expect(host.textContent).toContain("Nothing was written"); expect(document.activeElement).toBe(host.querySelector("[data-policy-receipt]"));
});
for (const state of ["stale", "invalid"] as const) test(`${state} consumes approval without changing bytes`, async () => {
  const host = await scene(); const before = await patch(state === "stale" ? { stale: true } : { mode: "invalid" });
  await page.getByRole("button", { name: "Approve and write", exact: true }).click();
  await expect.poll(() => host.querySelector(`[data-policy-state="${state}"]`)).not.toBeNull();
  expect((await patch()).bytes).toBe(before.bytes); expect((await patch()).writes).toBe(0);
  expect(host.textContent).toContain("Nothing was written"); expect(host.querySelector('[data-kit-approval-actions]')).toBeNull();
});
test("unknown completion reconciles the existing request; duplicates do not write twice", async () => {
  const host = await scene(320, "dark", 1, "drop-result"); await page.getByRole("button", { name: "Approve and write", exact: true }).click();
  await expect.poll(() => host.querySelector('[data-policy-state="unknown"]'), { timeout: 15_000 }).not.toBeNull();
  const answer = sent.find(message => message.type === "tool_approval")!; socket!.send(JSON.stringify(answer));
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect.poll(() => host.querySelector('[data-policy-state="updated"]')).not.toBeNull(); expect((await patch()).writes).toBe(1);
  expect(sent.filter(message => message.type === "tool_approval")).toHaveLength(1);
}, 25_000);
test("speech grants and different-turn replies cannot approve; account reads cannot borrow the receipt", async () => {
  const host = await scene(); const review = activeChat(ui!.stores.chat.getState()).messages.flatMap(m => m.toolCalls).find(t => t.policyChange)!.policyChange!;
  socket!.send(JSON.stringify({ type: "tool_approval", toolUseId: review.requestId, turnId: review.turnId, channel: "voice" }));
  socket!.send(JSON.stringify({ type: "tool_approval", toolUseId: review.requestId, turnId: "another-turn", channel: "card" }));
  await new Promise(resolve => setTimeout(resolve, 100)); expect((await patch()).writes).toBe(0);
  const selected = ui!.stores.chat.getState().activeSessionId; ui!.stores.chat.setState({ activeSessionId: "other-session" });
  await expect.poll(() => host.querySelector('[data-policy-change]')).toBeNull();
  expect((await patch()).writes).toBe(0); ui!.stores.chat.setState({ activeSessionId: selected });
  await expect.poll(() => host.querySelector('[data-policy-state="pending"]')).not.toBeNull();
  await patch({ account: true }); await expect(ui!.api.policyProposal(review.turnId, review.requestId, selected)).rejects.toThrow();
  expect((await patch()).writes).toBe(0);
});
test("invalid proposal never shows a card even with a remembered generic grant", async () => {
  const host = await scene(320, "dark", 1, "bad-proposal"); await new Promise(resolve => setTimeout(resolve, 100));
  expect(host.querySelector('[data-policy-change]')).toBeNull(); const r = await patch(); expect(r.bytes).toBe(r.original); expect(r.writes).toBe(0);
});

test("read-only settings use the admission cache's last valid/default facts and Open uses the existing viewer", async () => {
  const host = await scene(); await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect.poll(() => host.querySelector('[data-policy-state="declined"]')).not.toBeNull();
  const hash = (await patch()).policy.hash; await patch({ invalidFile: true });
  flushSync(() => renderer!.render(<BrainUiProvider root={ui!}><AgentPolicyGroup active /></BrainUiProvider>));
  await expect.poll(() => host.textContent).toContain("Enforcing the last valid version"); expect(host.textContent).toContain(hash);
  expect(host.querySelectorAll("textarea,input,select")).toHaveLength(0);
  await page.getByRole("button", { name: "Enforcing limits and protected paths", exact: true }).click();
  expect(host.textContent).toContain("Only reported enforcing limits are shown"); expect(host.textContent).not.toContain("512000000");
  await page.getByRole("button", { name: "Open governance policy", exact: true }).click();
  await expect.poll(() => ui!.stores.file.getState().currentPath).toBe("context/policies/governance.md");
  await patch({ missingFile: true });
  flushSync(() => renderer!.render(<BrainUiProvider root={ui!}><AgentPolicyGroup key="defaults" active /></BrainUiProvider>));
  await expect.poll(() => host.textContent).toContain("No policy file. Built-in defaults apply.");
});

// This deliberately refused transport verifies diagnostics, not the cause of #1872.
test("receipt diagnostics distinguish dispatch failure from an unread server receipt", async () => {
  await expect(scene(320, "dark", 1, "", true)).rejects.toThrow("Timeline (browser milliseconds from scene start)");
  expect(timeline).toContainEqual(expect.objectContaining({ stage: "chat-send" }));
  expect(timeline).toContainEqual(expect.objectContaining({ stage: "frame", type: "tool_approval_request" }));
  expect(timeline).toContainEqual(expect.objectContaining({ stage: "receipt-dispatch", session: "policy-session", epoch: 0 }));
  expect(timeline).toContainEqual(expect.objectContaining({ stage: "receipt-error", error: "Error: Controlled receipt transport failure" }));
  expect(timeline).toContainEqual(expect.objectContaining({ stage: "dom", state: "pending", actionable: false }));
  expect(timeline.at(-1)?.stage).toBe("readiness-failed");
  const state = await patch(); expect(state.reads).toBe(0); expect(state.writes).toBe(0); expect(state.receiptTimeline).toEqual([]);
  expect(host!.querySelector(approvalSelector)).toBeNull();
});
