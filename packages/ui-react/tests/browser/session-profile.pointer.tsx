import { ConnectionGate } from "../../src/components/connectivity/connection-gate.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import type { SessionWorkerProfile } from "@schlessera/brain-ui-sdk/protocol";
/// <reference types="@vitest/browser-playwright" />
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, afterEach, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { ModelPicker, type ModelPickerProps } from "../../../ui-kit/src/chrome/ModelPicker.js";
import "../../../ui-kit/src/styles.css";

let ui: BrainUiRoot | undefined;
let consumerStyles: HTMLStyleElement;
beforeAll(async () => { consumerStyles = document.createElement("style"); consumerStyles.textContent = await commands.formConsumerStyles(); document.head.append(consumerStyles); });
afterAll(() => consumerStyles.remove());
let renderer: Root | undefined;
let host: HTMLDivElement | undefined;
let outer: { width: number; height: number } | undefined;
const originalTheme = document.documentElement.dataset.theme;
const viewport = { width: innerWidth, height: innerHeight };
afterEach(async () => {
  if (renderer) flushSync(() => renderer!.unmount());
  renderer = undefined; ui?.dispose(); ui = undefined; vi.unstubAllGlobals(); host?.remove(); host = undefined;
  if (originalTheme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = originalTheme;
  await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
  outer = undefined;
});

async function mount(width: number, theme: "dark" | "light", disabledReason?: string) {
  const height = width === 640 ? 400 : 800;
  outer = await commands.formViewport(width, height);
  await page.viewport(width, height);
  document.documentElement.dataset.theme = theme;
  const save = vi.fn();
  let update!: (value: Partial<NonNullable<ModelPickerProps["chat"]>>) => void;
  function Harness() {
    const opener = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const [chat, setChat] = useState<NonNullable<ModelPickerProps["chat"]>>({
      profile: "governed", disabledReason, running: true, limits: null,
      onProfile: profile => { save(profile); setChat(current => ({ ...current, saving: true })); },
    });
    useEffect(() => { update = patch => flushSync(() => setChat(current => ({ ...current, ...patch }))); }, []);
    useEffect(() => { if (!open) opener.current?.focus(); }, [open]);
    return <div style={{ position: "fixed", inset: 0, padding: 16 }}>
      <button ref={opener} type="button" data-picker-opener="" onClick={() => setOpen(true)}>Ithaca model</button>
      <div style={{ position: "absolute", bottom: 16, left: 0, right: 0 }}>
        {open && <ModelPicker models={[{ id: "ithaca", label: "Ithaca model" }]} selectedModelId="ithaca" modelLocked
          phone={width < 900} chat={chat} onModel={() => {}} onEffort={() => {}} onDismiss={() => setOpen(false)} />}
      </div>
    </div>;
  }
  host = document.createElement("div"); document.body.append(host);
  renderer = createRoot(host); flushSync(() => renderer!.render(<Harness />));
  await document.fonts.ready;
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => host!.querySelector('[role="dialog"]')).not.toBeNull();
  return { save, update };
}

const profile = (name: string) => host!.querySelector<HTMLInputElement>(`input[data-profile][value="${name}"]`);
const limits = () => [...host!.querySelectorAll<HTMLElement>('[role="button"]')].find(el => el.textContent?.includes("Limits for this chat"))!;

for (const [width, theme] of [[320, "dark"], [320, "light"], [1280, "dark"], [1280, "light"], [640, "dark"]] as const) {
  test(`profile save keeps confirmed choice and focus, ${width} ${theme}`, async () => {
    const control = await mount(width, theme);
    expect(profile("governed"), "SESSION_PROFILE_AVAILABLE_WITH_FIXED_MODEL").not.toBeNull();
    expect(profile("governed")!.checked).toBe(true);
    profile("governed")!.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(control.save).toHaveBeenCalledExactlyOnceWith("strict");
    expect(profile("governed")!.checked, "pending save retains the confirmed value").toBe(true);
    expect(document.activeElement, "pending save retains radio focus").toBe(profile("strict"));
    expect(host!.textContent).toContain("Saving profile");
    control.update({ saving: false, error: "Profile could not be saved. Try again." });
    expect(profile("governed")!.checked, "failed save retains confirmed value").toBe(true);
    expect(document.activeElement, "failure does not steal focus").toBe(profile("strict"));
    expect(host!.querySelector('[role="alert"]')?.textContent).toContain("could not be saved");
    await userEvent.keyboard(" ");
    expect(control.save).toHaveBeenCalledTimes(2);
    control.update({ saving: false, error: undefined, profile: "strict" });
    expect(profile("strict")!.checked).toBe(true);
    expect(host!.textContent).toContain("This turn keeps its profile");
    await userEvent.tab();
    expect(document.activeElement, "limits are a native Tab destination").toBe(limits());
    expect(limits().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await userEvent.keyboard("{Enter}");
    expect(host!.textContent).toContain("Limits are unknown");
    for (const radio of host!.querySelectorAll<HTMLInputElement>("input[data-profile]")) {
      const row = radio.closest("label")!;
      expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    }
    expect(document.documentElement.scrollWidth, "no horizontal page overflow").toBeLessThanOrEqual(width);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => host!.querySelector('[role="dialog"]')).toBeNull();
    await expect.poll(() => document.activeElement).toBe(host!.querySelector("[data-picker-opener]"));
  });
}

for (const reason of ["Voice uses this brain's policy", "Set by this brain's policy.", "Needs the host."]) {
  test(`profile facts remain visible and read-only: ${reason}`, async () => {
    const control = await mount(320, "dark", reason);
    expect(profile("governed"), "SESSION_PROFILE_READ_ONLY_FACTS_REMAIN_VISIBLE").not.toBeNull();
    expect(host!.textContent).toContain(reason);
    expect(profile("strict")!.disabled).toBe(true);
    profile("strict")!.click();
    expect(control.save).not.toHaveBeenCalled();
    limits().focus(); await userEvent.keyboard("{Enter}");
    expect(host!.textContent).toContain("Limits are unknown");
  });
}


class ProfileSocket {
  static last: ProfileSocket;
  readyState = 0; onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null; onclose = null; onerror = null;
  sent: string[] = [];
  constructor() { ProfileSocket.last = this; }
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(frame: object) { flushSync(() => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)); }
  chats() { return this.sent.map(raw => JSON.parse(raw)).filter(frame => frame.type === "chat_message"); }
}
const profileFacts = (preference: "governed" | "strict" = "governed", patch: Partial<SessionWorkerProfile> = {}): SessionWorkerProfile => ({
  preference, policyProfile: "governed", policyHash: null, origin: "interactive", limits: [{ name: "Network recording", value: "Unknown" }], ...patch,
});
async function mountComposer(sessionId: string | null = "ithaca-chat", width = 1280, theme = "dark", gate = false) {
  await page.viewport(width, width === 640 ? 400 : 800);
  document.documentElement.dataset.theme = theme;
  vi.stubGlobal("WebSocket", ProfileSocket);
  const facts = new Map<string, SessionWorkerProfile>();
  const calls: { path: string; method: string; preference?: string }[] = [];
  let saveResponse: ((response: Response) => void) | undefined;
  let fail = false;
  let deferRead: string | undefined;
  let readResponse: ((response: Response) => void) | undefined;
  const providers = [{ id: "claude", label: "Ithaca model", backendId: "claude" }];
  const backends = { claude: { id: "claude", capabilities: { concurrentSessions: true, followUp: false } } };
  const request = async (input: string, init?: RequestInit) => {
    const path = new URL(input, "http://fixture.invalid").pathname;
    if (path.endsWith("/profile")) {
      const id = decodeURIComponent(path.split("/").at(-2)!);
      const method = init?.method ?? "GET";
      calls.push({ path, method, ...(method === "PUT" ? JSON.parse(String(init?.body)) : {}) });
      if (method === "PUT") {
        if (fail) return Response.json({ error: "Expired authentication" }, { status: 401 });
        return await new Promise<Response>(resolve => { saveResponse = resolve; });
      }
      if (id === deferRead) return await new Promise<Response>(resolve => { readResponse = resolve; });
      return Response.json(facts.get(id) ?? profileFacts("governed", { draftPreferenceStored: false }));
    }
    if (path.endsWith("/providers")) return Response.json({ providers, backends });
    if (path.endsWith("/sessions")) return Response.json({ sessions: [] });
    if (path.endsWith("/status")) return Response.json({ healthy: true, runtime: { boot: [], workerHost: { ordinary: { available: true, checkedAt: "2026-07-12T09:41:00.000Z", trigger: "boot" } } } });
    return Response.json({});
  };
  ui = createBrainUiRoot({ storage: null, request });
  ui.stores.provider.setState({ available: providers as never, backends, pinnedId: "claude", loaded: true });
  if (sessionId) {
    ui.stores.chat.getState().setActiveSession(sessionId);
    ui.stores.chat.getState().setSessionBackend(sessionId, "claude");
    ui.stores.chat.getState().setMessages(sessionId, []);
  }
  host = document.createElement("div"); host.style.cssText = "position:fixed;inset:0"; document.body.append(host);
  renderer = createRoot(host); flushSync(() => renderer!.render(<BrainUiProvider root={ui!}>{gate ? <ConnectionGate><AppShell><ChatPage /></AppShell></ConnectionGate> : <AppShell><ChatPage /></AppShell>}</BrainUiProvider>));
  ui.connection.connect(); const socket = ProfileSocket.last; flushSync(() => socket.open());
  socket.receive({ type: "server_hello", protocolRev: 5, principalKey: "athena-device", capabilities: { chatRequestAck: true, sessionProfiles: true } });
  await document.fonts.ready;
  const trigger = () => host!.querySelector<HTMLElement>("[data-model-trigger]")!;
  await expect.poll(trigger).not.toBeNull();
  trigger().focus(); await userEvent.keyboard("{Enter}");
  await expect.poll(() => profile("governed")?.disabled).toBe(false);
  return { socket, calls, facts, trigger,
    finishSave(value: SessionWorkerProfile) { saveResponse!(Response.json(value)); },
    failSave() { saveResponse!(Response.json({ error: "Failed save" }, { status: 500 })); },
    expire() { fail = true; },
    delayRead(id: string) { deferRead = id; },
    finishRead(value: SessionWorkerProfile) { readResponse!(Response.json(value)); },
  };
}

for (const [width, theme] of [[320, "dark"], [1280, "light"], [640, "dark"]] as const) test(`mounted Composer saves confirmed profile with fixed model, ${width} ${theme}`, async () => {
  const f = await mountComposer("ithaca-chat", width, theme);
  profile("governed")!.focus(); await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => f.calls.filter(call => call.method === "PUT").length).toBe(1);
  expect(profile("governed")!.checked, "SESSION_PROFILE_COMPOSER_PENDING_CONFIRMED").toBe(true);
  expect(document.activeElement).toBe(profile("strict"));
  f.failSave();
  await expect.poll(() => host!.textContent).toContain("Couldn't confirm");
  expect(profile("governed")!.checked).toBe(true); expect(document.activeElement).toBe(profile("strict"));
  await userEvent.keyboard(" ");
  await expect.poll(() => f.calls.filter(call => call.method === "PUT").length).toBe(2);
  f.finishSave(profileFacts("strict"));
  await expect.poll(() => profile("strict")!.checked).toBe(true);
  expect(document.activeElement).toBe(profile("strict"));
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(limits()); await userEvent.keyboard("{Enter}");
  expect(host!.textContent).toContain("Unknown");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.activeElement).toBe(f.trigger());
  expect(f.socket.chats()).toEqual([]);
});

test("mounted first send carries only its confirmed draft identity and waits for truthful named adoption", async () => {
  const f = await mountComposer(null);
  const draftId = ui!.stores.drafts.getState().idFor(null);
  profile("governed")!.focus(); await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => f.calls.some(call => call.method === "PUT")).toBe(true);
  f.finishSave(profileFacts("strict", { draftPreferenceStored: true }));
  await expect.poll(() => profile("strict")!.checked).toBe(true);
  await userEvent.keyboard("{Escape}");
  const field = host!.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
  await userEvent.fill(field, "Odysseus reviews the harbor.");
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => f.socket.chats().length).toBe(1);
  const sent = f.socket.chats()[0];
  expect(sent.profileDraftId, "SESSION_PROFILE_FIRST_SEND_EXISTING_DRAFT").toBe(draftId);
  expect(sent.draftId).toBeTruthy(); expect(sent.requestId).toBeTruthy();
  f.socket.receive({ type: "session_info", sessionId: "foreign-chat", isNew: true, draftId: "another-correlation", backendId: "claude" });
  expect(ui!.stores.chat.getState().activeSessionId, "SESSION_PROFILE_UNRELATED_NAME_NOT_ADOPTED").toBeNull();
  f.facts.set("ithaca-chat", profileFacts("strict", { actualProfile: "strict" }));
  f.socket.receive({ type: "session_info", sessionId: "ithaca-chat", isNew: true, draftId: sent.draftId, requestId: sent.requestId, backendId: "claude", workerProfile: profileFacts("strict", { actualProfile: "strict" }) });
  expect(ui!.stores.chat.getState().activeSessionId).toBe("ithaca-chat");
});

test("mounted late save and read receipts cannot change another chat", async () => {
  const f = await mountComposer();
  profile("governed")!.focus(); await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => f.calls.some(call => call.method === "PUT")).toBe(true);
  flushSync(() => { ui!.stores.chat.getState().setActiveSession("harbor-chat"); ui!.stores.chat.getState().setMessages("harbor-chat", []); });
  await expect.poll(() => profile("governed")?.checked).toBe(true);
  await expect.poll(() => profile("governed")?.getAttribute("aria-disabled")).toBeNull();
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  f.finishSave(profileFacts("strict"));
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  await expect.poll(() => profile("governed")?.checked).toBe(true);
  expect(profile("strict")!.checked, "SESSION_PROFILE_LATE_SAVE_SESSION_ISOLATION").toBe(false);
  f.delayRead("ogygia-chat");
  flushSync(() => { ui!.stores.chat.getState().setActiveSession("ogygia-chat"); ui!.stores.chat.getState().setMessages("ogygia-chat", []); });
  await expect.poll(() => f.calls.some(call => call.path.includes("ogygia-chat"))).toBe(true);
  flushSync(() => ui!.stores.chat.getState().setActiveSession("harbor-chat"));
  await expect.poll(() => profile("governed")?.checked).toBe(true);
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  f.finishRead(profileFacts("strict"));
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  await expect.poll(() => profile("governed")?.checked).toBe(true);
  expect(profile("strict")!.checked, "SESSION_PROFILE_LATE_READ_SESSION_ISOLATION").toBe(false);
});


test("mounted voice uses policy read-only while dictation remains interactive", async () => {
  const f = await mountComposer();
  await userEvent.keyboard("{Escape}");
  f.facts.set("ithaca-chat", profileFacts("strict", { origin: "voice", policyProfile: "governed", actualProfile: "governed" }));
  f.trigger().focus(); await userEvent.keyboard("{Enter}");
  await expect.poll(() => host!.textContent).toContain("Voice uses this brain's policy");
  await expect.poll(() => profile("governed")!.disabled).toBe(true);
  expect(profile("governed")!.checked, "SESSION_PROFILE_VOICE_DISPLAYS_POLICY_NOT_INTERACTIVE_PREFERENCE").toBe(true);
  expect(host!.textContent).toContain("Voice uses this brain's policy");
  const writes = f.calls.filter(call => call.method === "PUT").length;
  profile("strict")!.click(); expect(f.calls.filter(call => call.method === "PUT").length).toBe(writes);
  await userEvent.keyboard("{Escape}");
  f.facts.set("ithaca-chat", profileFacts());
  f.trigger().focus(); await userEvent.keyboard("{Enter}");
  await expect.poll(() => profile("governed")!.disabled).toBe(false);
  flushSync(() => ui!.stores.voice.setState({ mode: "dictate" }));
  expect(profile("governed"), "SESSION_PROFILE_DICTATION_GROUP_REMAINS_PRESENT").not.toBeNull();
  expect(profile("governed")!.disabled).toBe(false);
});

test("mounted policy lock and offline reasons stay readable with honest unknown limits", async () => {
  const f = await mountComposer();
  await userEvent.keyboard("{Escape}");
  f.facts.set("ithaca-chat", profileFacts("governed", { policyProfile: "strict" }));
  f.trigger().focus(); await userEvent.keyboard("{Enter}");
  await expect.poll(() => profile("strict")!.disabled).toBe(true);
  expect(profile("strict")!.checked).toBe(true); expect(host!.textContent).toContain("Set by this brain's policy");
  flushSync(() => ui!.stores.connection.getState().setWsStatus("disconnected"));
  expect(host!.textContent).toContain("Needs the host");
  expect(profile("strict")!.disabled).toBe(true);
  limits().focus(); await userEvent.keyboard("{Enter}");
  expect(host!.textContent).toContain("Unknown");
  expect(f.calls.filter(call => call.method === "PUT")).toEqual([]);
});


test("an expired save follows the existing auth lock without exposing old confirmed chat facts", async () => {
  const f = await mountComposer("ithaca-chat", 1280, "dark", true);
  f.expire(); profile("governed")!.focus(); await userEvent.keyboard("{ArrowDown}");
  await expect.poll(() => ui!.stores.chat.getState().activeSessionId).toBeNull();
  await expect.poll(() => profile("governed")).toBeNull();
  expect(profile("strict"), "SESSION_PROFILE_EXPIRED_AUTH_NO_OLD_SELECTION").toBeNull();
  expect(f.socket.chats()).toEqual([]);
});
