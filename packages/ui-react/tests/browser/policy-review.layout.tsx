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
function createEvidence() {
  return {
    timeline: [] as Array<Record<string, unknown>>, received: [] as unknown[], sent: [] as ClientMessage[],
    started: performance.now(), ui: undefined as BrainUiRoot | undefined,
    host: undefined as HTMLDivElement | undefined, fixture: undefined as typeof fixture,
  };
}
let evidence = createEvidence();
function record(stage: string, detail: Record<string, unknown> = {}, owner = evidence) {
  if (owner.timeline.length === 128) owner.timeline.shift();
  owner.timeline.push({ stage, ms: performance.now() - owner.started, session: owner.ui?.stores.chat.getState().activeSessionId,
    epoch: owner.ui?.authLock.epoch(), ...detail });
}
const approvalSelector = '[data-policy-change] [data-kit-approval-actions] [role="button"]';
// Turn admission and journal observation are the real host's serial durable
// work: each journal write checkpoints SQLite's WAL and commits with
// synchronous=FULL. One approval waits on about 37 fsyncs and the first
// proposal on about 50, using 0.2-0.75 s of Vitest's 1 s poll default on a
// quiet host. 30 ms of added flush latency alone fails both (#2004, #1872).
// This is a failure maximum, not a wait: each poll exits on its condition.
const HOST_COMPLETION_MS = 5_000;
const viewport = { width: innerWidth, height: innerHeight }, themeBefore = document.documentElement.dataset.theme;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(async () => { styles.remove(); await page.viewport(viewport.width, viewport.height); });
async function disposeScene() {
  const sceneObserver = observer, sceneRenderer = renderer, sceneUi = ui, sceneSocket = socket, sceneHost = host, sceneFixture = fixture;
  observer = undefined; renderer = undefined; ui = undefined; socket = undefined; host = undefined; fixture = undefined;
  evidence = createEvidence();
  sceneObserver?.disconnect();
  if (sceneRenderer) flushSync(() => sceneRenderer.unmount());
  sceneUi?.dispose(); sceneSocket?.close(); sceneHost?.remove();
  if (sceneFixture) await commands.policyServer({ op: "stop", id: sceneFixture.id });
}
afterEach(async () => {
  await disposeScene();
  if (themeBefore === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = themeBefore;
});
const patch = (value: Record<string, unknown> = {}) => commands.policyServer({ op: "set", id: fixture!.id, patch: value }) as Promise<{ bytes: string; original: string; proposed: string; writes: number; reads: number; publicationTimeline: Array<Record<string, unknown>>; receiptTimeline: Array<{ stage: string; ms: number; requestId: number; method: string; path: string; status?: number; principal: string }>; policy: { hash: string }; journalChanges: Array<{path: string;actor:string;class:string}>; journalPolicies: Array<{policy_hash:string|null}>; admitted: Array<{hash: string | null}>; events: Array<{actor:string;kind:string}> }>;
// Browser evidence must describe the failed poll, before the fixture RPC yields.
async function policyFailure(error: unknown, readFixture?: typeof patch, boundary = "readiness", owner = evidence) {
  record(`${boundary}-failed`, {}, owner);
  const browser = `${String(error)}\nTimeline (browser milliseconds from scene start): ${JSON.stringify(owner.timeline)}\nFrames: ${JSON.stringify(owner.received)}\nChat: ${JSON.stringify(activeChat(owner.ui!.stores.chat.getState()).messages)}\nDOM: ${owner.host!.textContent}`;
  const started = performance.now() - owner.started;
  const fixtureState = await (readFixture ? readFixture() : commands.policyServer({ op: "set", id: owner.fixture!.id, patch: {} }));
  const completed = performance.now() - owner.started;
  return new Error(`${browser}\nFixture (sampled after browser snapshot): ${JSON.stringify(fixtureState)}\nFixture sample (browser milliseconds from scene start): ${JSON.stringify({ started, completed })}`);
}
async function waitForPolicyUpdate(element: HTMLDivElement) {
  const owner = evidence;
  try { await expect.poll(() => element.querySelector('[data-policy-state="updated"]'), { timeout: HOST_COMPLETION_MS }).not.toBeNull(); }
  catch (error) { throw await policyFailure(error, undefined, "publication", owner); }
}
async function scene(width = 320, theme = "dark", zoom = 1, mode = "", rejectReceipt = false) {
  const sceneEvidence = evidence = createEvidence();
  const sceneRecord = (stage: string, detail: Record<string, unknown> = {}) => record(stage, detail, sceneEvidence);
  sceneRecord("scene", { width, theme, zoom, mode });
  await page.viewport(width, 1000); document.documentElement.dataset.theme = theme;
  const sceneFixture = sceneEvidence.fixture = fixture = await commands.policyServer({ op: "start" }) as NonNullable<typeof fixture>;
  await commands.policyServer({ op: "set", id: sceneFixture.id, patch: { mode } });
  const sceneUi = sceneEvidence.ui = ui = createBrainUiRoot({ storage: null, config: { backendUrl: sceneFixture.url }, request: (url, init) => {
    if (!String(url).includes("/policy-proposals/")) return fetch(url, init);
    const signal = init?.signal;
    sceneRecord("receipt-dispatch", { path: new URL(url).pathname, aborted: signal?.aborted ?? false });
    const aborted = () => sceneRecord("receipt-abort");
    signal?.addEventListener("abort", aborted, { once: true });
    const result = rejectReceipt ? Promise.reject<Response>(new Error("Controlled receipt transport failure")) : fetch(url, init);
    // Observe settlement without replacing the native fetch promise returned to the client.
    const cleanup = () => signal?.removeEventListener("abort", aborted);
    void result.then(
      response => { sceneRecord("receipt-response", { status: response.status }); cleanup(); },
      error => { sceneRecord("receipt-error", { error: String(error) }); cleanup(); },
    ).catch(() => { cleanup(); });
    return result;
  } });
  const sceneSocket = socket = new WebSocket(sceneFixture.url.replace("http:", "ws:") + "/ws");
  const send = sceneUi.connection.send = (message: ClientMessage) => {
    if (sceneSocket.readyState !== WebSocket.OPEN) return false;
    if (message.type === "tool_approval" || message.type === "tool_denial") {
      const toolUseId = message.toolUseId;
      const tool = activeChat(sceneUi.stores.chat.getState()).messages.flatMap(m => m.toolCalls).find(t => t.id === toolUseId);
      message = { ...message, turnId: tool?.policyChange?.turnId };
    }
    if (message.type === "tool_approval" || message.type === "tool_denial") sceneRecord("approval-dispatch", {
      type: message.type, toolUseId: message.toolUseId, turnId: message.turnId,
    });
    sceneEvidence.sent.push(message); sceneSocket.send(JSON.stringify(message)); return true;
  };
  // Disposed roots ignore late frames; diagnostic callbacks keep only their old evidence and DOM.
  sceneSocket.onmessage = event => { const frame = JSON.parse(event.data); sceneRecord("frame", { type: frame.type, sessionId: frame.sessionId, policyState: frame.policyChange?.state }); sceneEvidence.received.push(frame); const parsed = parseServerMessage(event.data); if (!parsed.ok) throw new Error(parsed.error); sceneUi.connection.handleServerMessage(parsed.message); };
  await expect.poll(() => sceneSocket.readyState).toBe(WebSocket.OPEN);
  sceneUi.stores.chat.setState({ activeSessionId: "policy-session" });
  sceneUi.stores.chat.getState().addUserMessage("policy-session", "Propose strict for the voyage.", "voice-dictate");
  sceneUi.stores.chat.getState().startAssistantMessage("policy-session");
  function View() {
    const calls = useChatStore(useShallow(s => activeChat(s).messages.flatMap(m => m.toolCalls)));
    return <><textarea data-composer aria-label="Message" style={{ width: "100%", boxSizing: "border-box" }} /><ToolCallTimeline live toolCalls={calls}
      onApproval={(id, allow, always) => replyToToolApproval(sceneUi, sceneUi.stores.chat.getState().activeSessionId, send, id, allow, always)} /></>;
  }
  const sceneHost = sceneEvidence.host = host = document.createElement("div"); sceneHost.style.cssText = `width:${Math.min(720, width / zoom)}px;zoom:${zoom};background:var(--bk-color-canvas);color:var(--bk-color-ink)`;
  document.body.append(sceneHost);
  const sceneRenderer = renderer = createRoot(sceneHost);
  flushSync(() => sceneRenderer.render(<BrainUiProvider root={sceneUi}><View /></BrainUiProvider>));
  sceneHost.querySelector<HTMLTextAreaElement>("textarea")!.focus();
  for (const type of ["pointerdown", "pointerup", "click"]) sceneHost.addEventListener(type, event => {
    const target = event.target instanceof Element ? event.target.closest('[data-kit-approval-actions] [role="button"]') : null;
    if (target) sceneRecord("approval-native-event", { type, phase: "capture", target: target.textContent, trusted: event.isTrusted,
      defaultPrevented: event.defaultPrevented, connected: target.isConnected, inert: !!target.closest("[inert]") });
  }, { capture: true, passive: true });
  let lastDom = "";
  // DOM delivery is observed after mutation; it is not the React passive-effect boundary.
  const sceneObserver = observer = new MutationObserver(() => {
    const card = sceneHost.querySelector("[data-policy-change]");
    const state = card?.getAttribute("data-policy-state") ?? null;
    const actionable = !!sceneHost.querySelector(approvalSelector);
    const snapshot = JSON.stringify({ state, actionable, text: card?.textContent ?? null });
    if (snapshot !== lastDom) { lastDom = snapshot; sceneRecord("dom", { state, actionable }); }
  });
  sceneObserver.observe(sceneHost, { childList: true, subtree: true, attributes: true, characterData: true });
  sceneRecord("chat-send");
  send({ type: "chat_message", text: "Propose strict for the voyage.", source: "voice-dictate" });
  if (mode !== "bad-proposal") {
    try { await expect.poll(() => sceneHost.querySelector(approvalSelector), { timeout: HOST_COMPLETION_MS }).not.toBeNull(); }
    catch (error) { throw await policyFailure(error, undefined, "readiness", sceneEvidence); }
  }
  return sceneHost;
}
test("a disposed policy scene's held real completion cannot change its replacement chat", async () => {
  await scene();
  const previousSocket = socket!, previousEvidence = evidence;
  const receive = previousSocket.onmessage!;
  let heldCompletion: MessageEvent | undefined;
  previousSocket.onmessage = event => {
    const parsed = parseServerMessage(event.data);
    if (parsed.ok && parsed.message.type === "tool_result" && parsed.message.policyChange?.state === "updated") heldCompletion = event;
    else receive.call(previousSocket, event);
  };
  await page.getByRole("button", { name: "Approve and write", exact: true }).click();
  await expect.poll(() => heldCompletion, { timeout: HOST_COMPLETION_MS, message: "the previous policy socket's real completion is held" }).toBeDefined();
  expect(heldCompletion!.target).toBe(previousSocket);
  expect((await patch()).writes).toBe(1);
  await disposeScene();
  await scene();
  const nextUi = ui!;
  const before = activeChat(nextUi.stores.chat.getState()).messages;
  const beforeTimeline = [...evidence.timeline], beforeFrames = [...evidence.received];
  const previousFrames = previousEvidence.received.length;
  await Promise.resolve().then(() => receive.call(previousSocket, heldCompletion!));
  expect(activeChat(nextUi.stores.chat.getState()).messages, "the old real completion leaves the replacement policy chat untouched").toBe(before);
  expect(evidence.timeline, "late policy diagnostics stay out of the replacement timeline").toEqual(beforeTimeline);
  expect(evidence.received, "late policy frames stay out of the replacement diagnostics").toEqual(beforeFrames);
  expect(previousEvidence.received).toHaveLength(previousFrames + 1);
  expect(previousEvidence.timeline.at(-1), "late diagnostic identity retains the disposed root epoch").toMatchObject({
    stage: "frame", type: "tool_result", session: "policy-session", epoch: previousEvidence.ui!.authLock.epoch(),
  });
});

test("a disposed policy scene's sender cannot use its replacement socket", async () => {
  await scene();
  const send = ui!.connection.send;
  await disposeScene();
  await scene();
  expect(socket!.readyState).toBe(WebSocket.OPEN);
  const count = evidence.sent.length;
  expect(send({ type: "chat_message", text: "Read the current policy." }), "the old policy sender refuses its closed socket").toBe(false);
  expect(evidence.sent.length, "the old sender adds no replacement policy frame").toBe(count);
});

test("a disposed policy request's abort and rejection diagnostics retain their original scene", async () => {
  await expect(scene(320, "dark", 1, "", true)).rejects.toThrow("Timeline (browser milliseconds from scene start)");
  const request = ui!.request, previousEvidence = evidence;
  await disposeScene();
  await scene();
  const before = [...evidence.timeline];
  const controller = new AbortController();
  const result = request(`${previousEvidence.fixture!.url}/api/policy-proposals/controlled`, { signal: controller.signal });
  controller.abort();
  await expect(result).rejects.toThrow("Controlled receipt transport failure");
  expect(evidence.timeline, "old receipt callbacks cannot append replacement policy evidence").toEqual(before);
  for (const stage of ["receipt-dispatch", "receipt-abort", "receipt-error"]) {
    expect(previousEvidence.timeline, `the old ${stage} retains its root identity`).toContainEqual(expect.objectContaining({
      stage, session: "policy-session", epoch: previousEvidence.ui!.authLock.epoch(),
    }));
  }
});

test("a disposed policy scene's native DOM listeners retain their original diagnostic owner", async () => {
  const previousHost = await scene(), previousEvidence = evidence;
  const previousButton = previousHost.querySelector<HTMLElement>(approvalSelector)!;
  await disposeScene();
  await scene();
  const before = [...evidence.timeline];
  // Detached React controls no longer approve; the host's diagnostic listener remains registered.
  const actions = document.createElement("div"); actions.dataset.kitApprovalActions = "";
  actions.append(previousButton); previousHost.append(actions);
  await Promise.resolve().then(() => previousButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(evidence.timeline, "the detached policy listener cannot append replacement evidence").toEqual(before);
  expect(previousEvidence.timeline.at(-1), "the detached listener records only its old root").toMatchObject({
    stage: "approval-native-event", type: "click", connected: false, epoch: previousEvidence.ui!.authLock.epoch(),
  });
});

test("a disposed policy scene's held native observer reads only its original DOM", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver")!;
  const NativeObserver = MutationObserver;
  let hold = false, held: (() => void) | undefined;
  Object.defineProperty(globalThis, "MutationObserver", { ...descriptor, value: class extends NativeObserver {
    constructor(callback: MutationCallback) {
      super((records, instance) => {
        if (hold && instance === observer) held = () => callback(records, instance);
        else callback(records, instance);
      });
    }
  } });
  try {
    const previousHost = await scene(), previousEvidence = evidence;
    hold = true;
    previousHost.querySelector("[data-policy-change]")!.setAttribute("data-policy-state", "held-old-policy");
    await expect.poll(() => held, { message: "the old policy observer's native delivery is held" }).toBeDefined();
    await disposeScene();
    Object.defineProperty(globalThis, "MutationObserver", descriptor);
    await scene();
    const before = [...evidence.timeline];
    await Promise.resolve().then(() => held!());
    expect(previousEvidence.timeline.at(-1), "the held policy observer sees its unmounted original DOM").toMatchObject({
      stage: "dom", state: null, actionable: false, epoch: previousEvidence.ui!.authLock.epoch(),
    });
    expect(evidence.timeline, "the held observer cannot record replacement policy DOM").toEqual(before);
  } finally { Object.defineProperty(globalThis, "MutationObserver", descriptor); }
});

test("a mounted policy approval retains its original root and sender when the active root changes", async () => {
  const previousHost = await scene(), previousUi = ui!;
  const turnId = activeChat(previousUi.stores.chat.getState()).messages.flatMap(message => message.toolCalls).find(tool => tool.policyChange)!.policyChange!.turnId;
  const replacement = createBrainUiRoot({ storage: null });
  const sent: ClientMessage[] = [];
  replacement.connection.send = message => { sent.push(message); return true; };
  replacement.stores.chat.setState({ activeSessionId: "replacement-policy-session" });
  ui = replacement;
  try {
    await page.getByRole("button", { name: "Approve and write", exact: true }).click();
    await expect.poll(() => previousHost.querySelector('[data-policy-state="updated"]'), {
      timeout: HOST_COMPLETION_MS, message: "the mounted approval still completes on its original policy root",
    }).not.toBeNull();
    expect((await patch()).writes).toBe(1);
    expect(evidence.sent.find(message => message.type === "tool_approval")?.turnId,
      "the policy sender resolves approval identity from its original root").toBe(turnId);
    expect(sent, "the mounted approval cannot send through the replacement root").toHaveLength(0);
  } finally { ui = previousUi; replacement.dispose(); }
});

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
  record("approval-click-start"); await approve.click(); record("approval-click-settled");
  await waitForPolicyUpdate(host);
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
  // Admission records its policy before the journal inserts the turn's row.
  await expect.poll(async () => { const state = await patch(); return [state.admitted.length, state.journalPolicies.length]; }, { timeout: HOST_COMPLETION_MS }).toEqual([2, 2]);
  const next = await patch(); expect(next.admitted.at(-1)?.hash).toBe(receipt.policy.hash); expect(next.journalPolicies.at(-1)?.policy_hash).toBe(receipt.policy.hash);
  expect(evidence.sent.filter(message => message.type === "tool_approval")).toHaveLength(1);
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
  const answer = evidence.sent.find(message => message.type === "tool_approval")!; socket!.send(JSON.stringify(answer));
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect.poll(() => host.querySelector('[data-policy-state="updated"]')).not.toBeNull(); expect((await patch()).writes).toBe(1);
  expect(evidence.sent.filter(message => message.type === "tool_approval")).toHaveLength(1);
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
  const sceneRenderer = renderer!, sceneUi = ui!;
  const hash = (await patch()).policy.hash; await patch({ invalidFile: true });
  flushSync(() => sceneRenderer.render(<BrainUiProvider root={sceneUi}><AgentPolicyGroup active /></BrainUiProvider>));
  await expect.poll(() => host.textContent).toContain("Enforcing the last valid version"); expect(host.textContent).toContain(hash);
  expect(host.querySelectorAll("textarea,input,select")).toHaveLength(0);
  await page.getByRole("button", { name: "Enforcing limits and protected paths", exact: true }).click();
  expect(host.textContent).toContain("Only reported enforcing limits are shown"); expect(host.textContent).not.toContain("512000000");
  await page.getByRole("button", { name: "Open governance policy", exact: true }).click();
  await expect.poll(() => ui!.stores.file.getState().currentPath).toBe("context/policies/governance.md");
  await patch({ missingFile: true });
  flushSync(() => sceneRenderer.render(<BrainUiProvider root={sceneUi}><AgentPolicyGroup key="defaults" active /></BrainUiProvider>));
  await expect.poll(() => host.textContent).toContain("No policy file. Built-in defaults apply.");
});

// This deliberately refused transport verifies diagnostics, not the cause of #1872.
test("receipt diagnostics distinguish dispatch failure from an unread server receipt", async () => {
  await expect(scene(320, "dark", 1, "", true)).rejects.toThrow("Timeline (browser milliseconds from scene start)");
  expect(evidence.timeline).toContainEqual(expect.objectContaining({ stage: "chat-send" }));
  expect(evidence.timeline).toContainEqual(expect.objectContaining({ stage: "frame", type: "tool_approval_request" }));
  expect(evidence.timeline).toContainEqual(expect.objectContaining({ stage: "receipt-dispatch", session: "policy-session", epoch: 0 }));
  expect(evidence.timeline).toContainEqual(expect.objectContaining({ stage: "receipt-error", error: "Error: Controlled receipt transport failure" }));
  expect(evidence.timeline).toContainEqual(expect.objectContaining({ stage: "dom", state: "pending", actionable: false }));
  expect(evidence.timeline.at(-1)?.stage).toBe("readiness-failed");
  const state = await patch(); expect(state.reads).toBe(0); expect(state.writes).toBe(0); expect(state.receiptTimeline).toEqual([]);
  expect(host!.querySelector(approvalSelector)).toBeNull();
});

// A fixture RPC can settle after more native frames/render work. It must not
// splice that later chat/DOM into the browser evidence from the failed poll.
test("readiness evidence stays at the failure boundary while fixture diagnostics yield", async () => {
  const host = await scene();
  const sceneUi = ui!, sceneEvidence = evidence, sceneFixture = fixture!;
  const chatBefore = JSON.stringify(activeChat(ui!.stores.chat.getState()).messages);
  const domBefore = host.textContent;
  const failure = await policyFailure(new Error("Controlled snapshot boundary"), async () => {
    const state = await commands.policyServer({ op: "set", id: sceneFixture.id, patch: {} }) as Awaited<ReturnType<typeof patch>>;
    sceneUi.stores.chat.getState().addUserMessage("policy-session", "Later diagnostic message.");
    host.append(document.createTextNode("Later diagnostic DOM."));
    record("controlled-late-update", {}, sceneEvidence);
    return state;
  });
  expect(host.textContent).toContain("Later diagnostic DOM.");
  expect(JSON.stringify(activeChat(ui!.stores.chat.getState()).messages)).toContain("Later diagnostic message.");
  expect(failure.message).toContain(`Chat: ${chatBefore}\nDOM: ${domBefore}`);
  expect(failure.message).not.toContain("Later diagnostic");
  expect(failure.message).not.toContain("controlled-late-update");
  const fixtureLine = failure.message.split("\n").find(line => line.startsWith("Fixture (sampled after browser snapshot): "))!;
  const fixtureState = JSON.parse(fixtureLine.slice(fixtureLine.indexOf(": ") + 2));
  expect(fixtureState.reads).toBe(1);
  expect(fixtureState.writes).toBe(0);
  expect(fixtureState.receiptTimeline).toEqual([
    expect.objectContaining({ stage: "request", method: "GET" }),
    expect.objectContaining({ stage: "response", status: 200 }),
  ]);
});


// The existing dropped-result mode withholds native completion frames after a
// real write. It validates the evidence path, not the historical cause of #2004.
test("publication diagnostics retain a missed completion after a successful host write", async () => {
  const element = await scene(320, "dark", 1, "drop-result");
  record("approval-click-start");
  await page.getByRole("button", { name: "Approve and write", exact: true }).click();
  record("approval-click-settled");
  let failure: unknown;
  try { await waitForPolicyUpdate(element); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  const message = (failure as Error).message;
  expect(message).toContain('"stage":"publication-failed"');
  expect(message).toContain("DOM: Writing the policy");
  const timelineLine = message.split("\n").find(line => line.startsWith("Timeline (browser milliseconds from scene start): "))!;
  const frozenTimeline = JSON.parse(timelineLine.slice(timelineLine.indexOf(": ") + 2));
  expect(frozenTimeline).toContainEqual(expect.objectContaining({ stage: "approval-native-event", type: "click", phase: "capture", trusted: true, connected: true, inert: false }));
  expect(frozenTimeline).toContainEqual(expect.objectContaining({ stage: "approval-dispatch", type: "tool_approval", session: "policy-session", epoch: 0 }));
  const fixtureLine = message.split("\n").find(line => line.startsWith("Fixture (sampled after browser snapshot): "))!;
  const state = JSON.parse(fixtureLine.slice(fixtureLine.indexOf(": ") + 2));
  expect(state.bytes).toBe(state.proposed);
  expect(state.writes).toBe(1);
  expect(state.publicationTimeline).toContainEqual(expect.objectContaining({ stage: "write-complete", writes: 1 }));
  expect(state.publicationTimeline).toContainEqual(expect.objectContaining({ stage: "observation-settled", outcome: "complete" }));
  expect(state.publicationTimeline).toContainEqual(expect.objectContaining({ stage: "outgoing-frame", type: "tool_result", policyState: "updated", suppressed: true }));
  expect(evidence.received.some(frame => (frame as { type: string }).type === "tool_result")).toBe(false);
});
