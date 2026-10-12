import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";

// Real consumer DOM and Chromium. Only the lowest transport is a fixture;
// measurements enter through the same WebSocket result/history handlers.
class Socket {
  static last: Socket;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose = null;
  onerror = null;
  sent: string[] = [];
  constructor() { Socket.last = this; }
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(data: object) { flushSync(() => this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)); }
  frames(type: string) { return this.sent.map(raw => JSON.parse(raw)).filter(frame => frame.type === type); }
}
const MIB = 1024 * 1024;
const T0 = Date.UTC(2026, 6, 12, 9, 41);
const SESSION = "odysseus-ithaca";
const providers = [{ id: "claude", label: "Claude", backendId: "claude" }];
const measurement = (percent = 80, allowance = 64 * MIB, observedAt = T0) => ({ usedBytes: Math.floor(allowance * percent / 100), allowanceBytes: allowance, observedAt });
let renderer: Root | undefined;
let root: BrainUiRoot | undefined;
let host: HTMLDivElement | undefined;
let styles: HTMLStyleElement;
let viewport: { width: number; height: number };
let previousTheme: string | undefined;
beforeAll(async () => {
  viewport = { width: innerWidth, height: innerHeight };
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
function unmount() {
  if (renderer) flushSync(() => renderer!.unmount());
  root?.dispose(); host?.remove(); renderer = undefined; root = undefined; host = undefined;
}
afterEach(() => { unmount(); document.documentElement.dataset.theme = previousTheme ?? "dark"; vi.unstubAllGlobals(); });
afterAll(async () => { styles.remove(); await page.viewport(viewport.width, viewport.height); });
async function mount(width = 1280, theme = "dark", storage: Storage | null = null, height = 800) {
  await page.viewport(width, height);
  previousTheme = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = theme;
  vi.stubGlobal("WebSocket", Socket);
  const backends = { claude: { id: "claude", capabilities: { concurrentSessions: true, followUp: false, autonomous: true }, stateRoomAllowance: { bytes: 64 * MIB, observedAt: T0 } } };
  const request = async (input: string) => {
    const path = new URL(String(input), "http://fixture.invalid").pathname;
    if (path.endsWith("/providers")) return Response.json({ providers, backends });
    if (path.endsWith("/sessions")) return Response.json({ sessions: [{ id: SESSION, title: "The way home", backendId: "claude", createdAt: T0, lastActiveAt: T0, totalCostUsd: 0, numTurns: 1 }] });
    if (path.endsWith("/status")) return Response.json({ healthy: true, runtime: { boot: [], workerHost: { ordinary: { available: true, checkedAt: "2026-07-12T09:41:00.000Z", trigger: "boot" } } } });
    return Response.json({});
  };
  vi.stubGlobal("fetch", vi.fn(async input => request(String(input))));
  root = createBrainUiRoot({ storage, storagePrefix: "odysseus-state-room", request });
  root.stores.provider.setState({ available: providers as never, backends, pinnedId: "claude", loaded: true });
  root.stores.chat.getState().setActiveSession(SESSION);
  root.stores.chat.getState().setSessionBackend(SESSION, "claude");
  root.stores.chat.getState().setMessages(SESSION, []);
  host = document.createElement("div"); host.style.cssText = "position:fixed;inset:0"; document.body.append(host);
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<BrainUiProvider root={root!}><AppShell><ChatPage /></AppShell></BrainUiProvider>));
  root.connection.connect(); const socket = Socket.last; flushSync(() => socket.open());
  await document.fonts.ready;
  return { root, socket };
}
function result(socket: Socket, percent = 80, allowance = 64 * MIB, observedAt = T0) {
  socket.receive({ type: "result", sessionId: SESSION, costUsd: 0, durationMs: 1, numTurns: 1, isError: false, stateRoom: measurement(percent, allowance, observedAt) });
}
const notice = () => host!.querySelector<HTMLElement>("[data-state-room-notice]");

for (const width of [320, 1280]) for (const theme of ["light", "dark"]) test(`${width} ${theme}: factual warning, usable targets and no unsolicited focus or work`, async () => {
  const { socket } = await mount(width, theme);
  const composer = host!.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
  composer.focus();
  result(socket, 50);
  expect(notice()).toBeNull();
  result(socket);
  await expect.poll(notice).not.toBeNull();
  expect(notice()!.textContent).toContain("This conversation is nearing its saved-state limit: 51.2 MiB of 64 MiB (80%).");
  expect(notice()!.textContent).toContain("As of the last turn");
  expect(document.activeElement).toBe(composer);
  expect(notice()!.scrollWidth).toBeLessThanOrEqual(notice()!.clientWidth + 1);
  for (const target of notice()!.querySelectorAll<HTMLElement>('[role="button"]')) {
    const box = target.getBoundingClientRect(); expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.right).toBeLessThanOrEqual(width + 1);
  }
  expect(socket.frames("handoff_prepare")).toEqual([]);
  expect(socket.frames("chat_message")).toEqual([]);
  await userEvent.click(page.getByRole("button", { name: "Not now", exact: true }));
  await expect.poll(notice).toBeNull(); expect(document.activeElement).toBe(composer);
  result(socket, 81); expect(notice()).toBeNull();
});

test("dismissal survives reload for the allowance, while changed allowance waits for fresh measurement", async () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } as Storage;
  let scene = await mount(1280, "dark", storage); result(scene.socket);
  await expect.poll(notice).not.toBeNull();
  await userEvent.click(page.getByRole("button", { name: "Not now", exact: true }));
  unmount(); scene = await mount(1280, "dark", storage);
  scene.socket.receive({ type: "session_history", sessionId: SESSION, messages: [], stateRoom: measurement() });
  expect(notice()).toBeNull();
  flushSync(() => scene.root.stores.provider.setState({ backends: { claude: { id: "claude", capabilities: { concurrentSessions: true, followUp: false, autonomous: true }, stateRoomAllowance: { bytes: 128 * MIB, observedAt: T0 + 10 } } } }));
  expect(notice()).toBeNull();
  await expect.poll(() => scene.root.stores.chat.getState().stateRoomPreferences[SESSION]?.dismissedAllowance).toBeUndefined();
  result(scene.socket, 80, 128 * MIB, T0 + 20);
  await expect.poll(notice).not.toBeNull();
  expect(notice()!.textContent).toContain("102.4 MiB of 128 MiB (80%)");
});

test("historical and offline numbers stay aged; unavailable continuation cannot prepare work", async () => {
  const { root: ui, socket } = await mount();
  socket.receive({ type: "session_history", sessionId: SESSION, messages: [], stateRoom: measurement() });
  await expect.poll(notice).not.toBeNull();
  expect(notice()!.querySelector('[role="status"]')!.textContent).toBe("");
  flushSync(() => ui.stores.connection.setState({ wsStatus: "disconnected" }));
  expect(notice()!.textContent).toContain("needs the host");
  const entry = page.getByRole("button", { name: "Continue in a new conversation", exact: true }).element() as HTMLElement;
  expect(entry.getAttribute("aria-disabled")).toBe("true"); entry.click();
  expect(socket.frames("handoff_prepare")).toEqual([]); expect(ui.stores.handoff.getState().sheet).toBeNull();
});

test("a delayed empty history response cannot erase a newer live result's measured warning", async () => {
  const { root: ui, socket } = await mount();
  // The resume request is outstanding when the admitted turn finishes.
  socket.receive({ type: "server_hello", protocolRev: 5, capabilities: {} });
  expect(ui.connection.send({ type: "session_resume", sessionId: SESSION })).toBe(true);
  await expect.poll(() => socket.frames("session_resume").length).toBe(1);
  result(socket, 80, 64 * MIB, T0 + 20);
  await expect.poll(notice).not.toBeNull();
  socket.receive({ type: "session_history", sessionId: SESSION, messages: [] });
  expect(ui.stores.chat.getState().stateRooms[SESSION]?.observation, "LIVE_MEASUREMENT_SURVIVES_EMPTY_HISTORY").toEqual(measurement(80, 64 * MIB, T0 + 20));
  expect(notice()).not.toBeNull();
  socket.receive({ type: "session_history", sessionId: SESSION, messages: [], stateRoom: measurement(50, 64 * MIB, T0) });
  expect(ui.stores.chat.getState().stateRooms[SESSION]?.observation).toEqual(measurement(80, 64 * MIB, T0 + 20));
  result(socket, 50, 64 * MIB, T0 + 10);
  expect(ui.stores.chat.getState().stateRooms[SESSION]?.observation).toEqual(measurement(80, 64 * MIB, T0 + 20));
});

test("auth loss clears live and boot warning metadata, and a foreign account or old socket cannot restore it", async () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } as Storage;
  const { root: ui, socket } = await mount(1280, "dark", storage); result(socket);
  await expect.poll(notice).not.toBeNull();
  await userEvent.click(page.getByRole("button", { name: "Not now", exact: true }));
  expect(ui.stores.chat.getState().stateRoomPreferences[SESSION]).toBeDefined();
  ui.stores.connection.getState().setVpnStatus("connected", "odysseus-key");
  await ui.authLock.expire(); flushSync(() => ui.authLock.dropContext());
  expect(ui.stores.chat.getState().stateRooms).toEqual({});
  expect(ui.stores.chat.getState().stateRoomPreferences).toEqual({});
  expect(ui.stores.chat.getInitialState().stateRoomPreferences).toEqual({});
  expect(await ui.authLock.signedIn("penelope-key")).toBe(false);
  socket.receive({ type: "session_history", sessionId: SESSION, messages: [], stateRoom: measurement() });
  expect(ui.stores.chat.getState().stateRooms).toEqual({}); expect(notice()).toBeNull();
  unmount(); await mount(1280, "dark", storage);
  // Reload intentionally retains only preferences. No server-authorized
  // measurement has arrived, so there is no warning or invented usage.
  expect(root!.stores.chat.getState().stateRooms).toEqual({}); expect(notice()).toBeNull();
});

test("an allowance change while a different conversation is visible invalidates the old dismissal even if the allowance changes back", async () => {
  const { root: ui, socket } = await mount(); result(socket);
  await expect.poll(notice).not.toBeNull();
  await userEvent.click(page.getByRole("button", { name: "Not now", exact: true }));
  flushSync(() => ui.stores.chat.getState().setActiveSession("odysseus-ogygia"));
  const original = ui.stores.provider.getState().backends.claude!;
  flushSync(() => ui.stores.provider.setState({ backends: { claude: { ...original, stateRoomAllowance: { bytes: 128 * MIB, observedAt: T0 + 10 } } } }));
  expect(ui.stores.chat.getState().stateRoomPreferences[SESSION]?.dismissedAllowance).toBeUndefined();
  flushSync(() => {
    ui.stores.provider.setState({ backends: { claude: { ...original, stateRoomAllowance: { bytes: 64 * MIB, observedAt: T0 + 20 } } } });
    ui.stores.chat.getState().setActiveSession(SESSION);
  });
  expect(notice()).toBeNull();
  result(socket, 80, 64 * MIB, T0 + 30);
  await expect.poll(notice).not.toBeNull();
});

test("voice keeps the factual notice visual only, without a live announcement", async () => {
  const { root: ui, socket } = await mount();
  flushSync(() => ui.stores.voice.setState({ mode: "dictate" })); result(socket);
  await expect.poll(notice).not.toBeNull();
  const status = notice()!.querySelector('[role="status"]')!;
  expect(status.getAttribute("aria-live")).toBe("off"); expect(status.textContent).toBe("");
  expect(socket.frames("chat_message")).toEqual([]);
  flushSync(() => ui.stores.voice.setState({ mode: "idle" }));
  expect(status.textContent).toBe("");
});

test("a newly displayed measured notice announces once, without stale or repeated announcement text", async () => {
  const { socket } = await mount(); result(socket);
  await expect.poll(() => notice()?.querySelector('[role="status"]')?.textContent).toContain("(80%)");
  result(socket, 81, 64 * MIB, T0 + 1);
  await expect.poll(() => notice()?.querySelector('[role="status"]')?.textContent).toBe("");
  expect(notice()!.textContent).toContain("(81%)");
  result(socket, 50, 64 * MIB, T0 + 2); expect(notice()).toBeNull();
  result(socket, 80, 64 * MIB, T0 + 3);
  await expect.poll(notice).not.toBeNull();
  expect(notice()!.querySelector('[role="status"]')!.textContent).toBe("");
});

test("busy and intrinsic refusal retain their distinct treatment ahead of the warning", async () => {
  const { root: ui, socket } = await mount(); result(socket);
  await expect.poll(notice).not.toBeNull();
  for (const errorClass of ["worker_state_busy", "session_too_large", "worker_state_exceeded"]) {
    flushSync(() => {
      ui.stores.chat.getState().addUserMessage(SESSION, "Plan the next leg.", "typed");
      ui.stores.chat.getState().startAssistantMessage(SESSION);
    });
    socket.receive({ type: "result", sessionId: SESSION, durationMs: 1, numTurns: 1, isError: true,
      failure: { errorClass, message: "Fixture refusal", retryable: errorClass === "worker_state_busy" }, stateRoom: measurement(90, 128 * MIB, T0 + 1) });
    expect(notice()).toBeNull();
    expect(ui.stores.chat.getState().buffers[SESSION]!.messages.at(-1)!.failure?.errorClass).toBe(errorClass);
    expect(ui.stores.chat.getState().stateRooms[SESSION]!.observation).toEqual(measurement());
  }
});

test("continuation keeps reviewed cost, source preference, cancellation focus and explicit destination start", async () => {
  const { root: ui, socket } = await mount();
  flushSync(() => {
    ui.stores.chat.getState().addUserMessage(SESSION, "Plan the return to Ithaca.", "typed");
    ui.stores.chat.getState().startAssistantMessage(SESSION);
    ui.stores.chat.getState().appendText(SESSION, "Sail past the Sirens.");
  });
  result(socket); await expect.poll(notice).not.toBeNull();
  const opener = page.getByRole("button", { name: "Continue in a new conversation", exact: true });
  (opener.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => host!.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
  const dialog = host!.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]')!;
  expect((dialog.querySelector("select") as HTMLSelectElement).value).toBe("claude");
  await expect.poll(() => dialog.textContent).toContain("spends"); expect(dialog.textContent).toContain("Nothing is sent until you start it.");
  await expect.poll(() => socket.frames("handoff_prepare").length).toBe(1);
  expect(socket.frames("chat_message")).toEqual([]);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => host!.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();
  await expect.poll(() => document.activeElement).toBe(opener.element());
  expect(socket.frames("handoff_prepare_cancel")).toHaveLength(1);
  expect(socket.frames("chat_message")).toEqual([]);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => socket.frames("handoff_prepare").length).toBe(2);
  const prepare = socket.frames("handoff_prepare").at(-1)!;
  socket.receive({ type: "handoff_draft", handoffId: prepare.handoffId, sourceSessionId: SESSION,
    state: "ready", text: "Continue the return to Ithaca.", model: "claude", costUsd: 0.01 });
  await userEvent.click(page.getByRole("button", { name: "Start new chat on Claude", exact: true }));
  await expect.poll(() => socket.frames("chat_message").length).toBe(1);
  expect(socket.frames("chat_message")[0].handoff.sourceSessionId).toBe(SESSION);
  expect(ui.stores.chat.getState().buffers[SESSION]!.messages).toHaveLength(2);
});

for (const theme of ["light", "dark"]) test(`${theme}: reflow at the 640 CSS pixels of a 1280px desktop at 200% zoom`, async () => {
  // Browser zoom halves its layout viewport, including media queries. CSS
  // zoom on one subtree would leave desktop panes active and is not that proof.
  const { socket } = await mount(640, theme, null, 400); result(socket);
  await expect.poll(notice).not.toBeNull();
  expect(notice()!.scrollWidth).toBeLessThanOrEqual(notice()!.clientWidth + 1);
  for (const target of notice()!.querySelectorAll<HTMLElement>('[role="button"]')) {
    expect(target.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(target.getBoundingClientRect().right).toBeLessThanOrEqual(641);
    expect(target.getBoundingClientRect().bottom).toBeLessThanOrEqual(401);
  }
});
