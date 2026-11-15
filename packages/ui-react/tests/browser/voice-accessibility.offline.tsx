/// <reference types="@vitest/browser-playwright" />
/**
 * Voice in the assembled app, for a keyboard and a screen reader (#3701).
 *
 * The real ChatPage, under the ui-react-layout project's reduced motion. Each
 * dictation (D), Start (S) and live (L) state is reached by keyboard alone,
 * with no long-press, and every step asserts three things: what a live region
 * says and how urgently, where focus is, and that nothing animates. axe checks
 * every integrated screen as it is drawn.
 *
 * Inert: the live states are the client's own state set directly, as
 * conversation-controls.offline.tsx does. No test opens a microphone or a
 * provider. Dictation uses a scripted recognizer in place of the browser's.
 */
import { afterAll, afterEach, beforeAll, expect, test, vi, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import axe from "axe-core";
import { CONVERSATION_LIMITS, type ServerConversationOpened } from "@schlessera/brain-ui-sdk/protocol";
import { conversationProfileSchema, serverHelloSchema } from "@schlessera/brain-ui-sdk/schemas";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { ConversationClientState } from "../../src/voice/conversation-client.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { installFaultNetwork, type FaultNetwork } from "./offline/fault-network.js";
import { singleProviderDiscovery } from "../fixtures/dictation-discovery.js";

const SESSION = "odysseus-ithaca";
const PROFILE: ServerConversationOpened = { type: "conversation_opened", conversationId: "ithaca-voice", epoch: 1, sessionId: SESSION, providerId: "gpt-live", capabilities: { nonblockingWork: "supported", manualEndpoint: "supported", finalTranscript: "unproven", remoteOutputCancelAck: "unproven", exactPermissionSpeech: "unproven", echoIsolatedInput: "unproven", outputWordAlignment: "unproven" }, disclosure: { voiceService: "Odysseus voice fixture", destinations: ["Audio and transcripts: fictional fixture. Retention: unknown."] }, limits: { ...CONVERSATION_LIMITS }, resync: { work: 0, outputs: 0 } };
const DISCLOSED = conversationProfileSchema.parse({ providerId: PROFILE.providerId, capabilities: PROFILE.capabilities, disclosure: PROFILE.disclosure });
const HELLO = serverHelloSchema.parse({ type: "server_hello", protocolRev: 5, principalKey: "odysseus-principal", capabilities: { liveConversation: true, conversationPause: true, toolResolution: true, chatRequestAck: true }, conversationProfile: DISCLOSED });

let styles: HTMLStyleElement;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());
afterEach(() => { vi.unstubAllGlobals(); });

type Scene = { ui: BrainUiRoot; host: HTMLDivElement; net: FaultNetwork; announced: { level: string; text: string }[] };

/** The chat page in the shell at 1280×720, with every live-region change recorded as it happens. */
async function mount(ctx: TestContext, dictation: boolean): Promise<Scene> {
  const viewport = { width: innerWidth, height: innerHeight };
  const outer = await commands.formViewport(1280, 720);
  await page.viewport(1280, 720);
  const net = installFaultNetwork({
    routes: url => url.pathname.endsWith("/sessions") ? Response.json({ sessions: [] }) : url.pathname.endsWith("/voice/overrides") ? Response.json({ overrides: [] })
      : url.pathname.endsWith("/voice/session") ? Response.json({ providerId: "webspeech", url: "wss://speech.invalid/v1/listen", token: "odysseus-grant", expiresAt: Date.now() + 3_600_000, capabilities: { streaming: true, interimResults: true, keyterms: false, endpointing: false } }) : undefined,
    onOpen(socket) { socket.deliver(HELLO); socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false }); socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] }); socket.deliver({ type: "status", sessionId: SESSION, status: "idle" }); },
  });
  const ui = createBrainUiRoot({ storage: null, request: net.request });
  // Dictation is offered, and not yet acknowledged on this device: the first take asks first (D0).
  if (dictation) ui.stores.voice.setState({ discovery: { snapshot: singleProviderDiscovery("webspeech"), at: Date.now() + 86_400_000 } });
  ui.stores.chat.getState().setActiveSession(SESSION);
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;inset:0;width:1280px;height:720px";
  document.body.append(host);
  const renderer = createRoot(host);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><AppShell><ChatPage /></AppShell></BrainUiProvider>));
  const release = ui.connection.connect();
  const announced: Scene["announced"] = [];
  const seen = new Map<Element, string>();
  const observer = new MutationObserver(() => {
    for (const region of host.querySelectorAll("[aria-live], [role=status], [role=alert]")) {
      const text = region.textContent ?? "";
      if (seen.get(region) === text) continue;
      seen.set(region, text);
      const level = region.getAttribute("aria-live") ?? (region.getAttribute("role") === "alert" ? "assertive" : "polite");
      if (text) announced.push({ level, text });
    }
  });
  observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true });
  ctx.onTestFinished(async () => { observer.disconnect(); flushSync(() => renderer.unmount()); release(); ui.dispose(); net.restore(); host.remove(); await page.viewport(viewport.width, viewport.height); await commands.formViewport(outer.width - 100, outer.height - 120); });
  await expect.poll(() => ui.stores.connection.getState().wsStatus).toBe("connected");
  return { ui, host, net, announced };
}

const mic = (s: Scene) => s.host.querySelector<HTMLButtonElement>('[data-composer-mic] button[aria-label^="Dictate"]');
const textarea = (s: Scene) => s.host.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
const named = (root: ParentNode | null, name: string) => [...root?.querySelectorAll<HTMLElement>("button") ?? []].find(b => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name) ?? null;
const frame = () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));

/** The newest thing a live region said. */
const last = (s: Scene, level: "polite" | "assertive") => s.announced.filter(entry => entry.level === level).at(-1)?.text;

/** Whether an animation changes anything: two keyframes that differ in a property. */
function moves(animation: Animation) {
  const frames = (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? [];
  const values = frames.map(({ offset: _o, computedOffset: _c, easing: _e, composite: _m, ...rest }) => JSON.stringify(rest));
  return new Set(values).size > 1;
}

/**
 * Nothing is moving: no CSS animation or transition is running anywhere on
 * the page. The kit's `breathe` keeps running under reduced motion with its
 * keyframe redefined to the one rest frame (tokens.css, "Reduced motion"), so
 * an animation counts only if its keyframes change something.
 */
async function still(what: string) {
  await frame();
  const running = document.getAnimations().filter(a => a.playState === "running" && moves(a)).map(a => {
    const target = (a.effect as KeyframeEffect | null)?.target as Element | null;
    return `${(a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.constructor.name} on ${target?.className || target?.tagName}`;
  });
  expect(running, `${what}: reduced motion runs no animation`).toEqual([]);
}

async function accessible(node: Element | null, what: string) {
  expect(node, what).not.toBe(null);
  const { violations } = await axe.run(node!);
  expect(violations.flatMap(v => v.nodes.map(n => `${v.id} ${n.target.join(" ")}: ${n.failureSummary}`)), `${what}: axe`).toEqual([]);
}

/** Tab (or Shift+Tab) until `target` has focus; a stop it cannot reach fails. */
async function tabTo(target: () => Element | null, back = false, stops = 24) {
  for (let i = 0; i < stops && document.activeElement !== target(); i++) await userEvent.keyboard(back ? "{Shift>}{Tab}{/Shift}" : "{Tab}");
  expect(document.activeElement, "reachable in tab order").toBe(target());
}

test("live: Talk live… by keyboard, the Start card's focus and notices, every L state announced, focus handed on, nothing moving", async ctx => {
  const s = await mount(ctx, false);
  const client = s.ui.connection.conversation;
  await expect.poll(() => client.state.getState().available).toBe(true);
  await expect.poll(() => mic(s)).not.toBe(null);
  await accessible(s.host.querySelector("[data-composer]")?.closest(".mx-auto") ?? s.host, "the composer at rest");

  // No long-press: "Talk live…" is in the tab order beside the mic.
  textarea(s).focus();
  await tabTo(() => named(s.host, "Talk live…"));
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => client.state.getState().disclosureOpen).toBe(true);
  const card = () => s.host.querySelector<HTMLElement>("[data-start-card]");
  // The card is a dialog-like group whose first control is Start; it takes focus.
  await expect.poll(() => document.activeElement).toBe(card()?.querySelector(".bk-voice-start"));
  await still("S2 Start card");
  await accessible(card(), "the Start card");
  // A change to the card's notice is said politely, without moving focus.
  flushSync(() => client.state.setState({ notice: "The Ithaca relay is slow to answer. Start may take a moment." }));
  await expect.poll(() => last(s, "polite")).toBe("The Ithaca relay is slow to answer. Start may take a moment.");
  expect(card()!.querySelector("[data-start-announcement]")!.getAttribute("aria-live")).toBe("polite");
  expect(document.activeElement, "a notice does not take focus").toBe(card()!.querySelector(".bk-voice-start"));
  flushSync(() => client.state.setState({ notice: "" }));
  // Escape cancels Start, and focus returns to the mic that opened it.
  await userEvent.keyboard("{Escape}");
  expect(client.state.getState().active).toBe(false);
  await expect.poll(() => document.activeElement, { message: "Escape returns focus to the mic" }).toBe(mic(s));
  expect(s.net.socket()!.frames("conversation_start"), "nothing opened").toHaveLength(0);

  // Again, and Start: the field opens connecting (S5), then every live state in turn.
  await tabTo(() => named(s.host, "Talk live…"), true);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => card()).not.toBe(null);
  flushSync(() => client.state.setState({ disclosureOpen: false, sessionId: SESSION, connection: "Connecting", capture: "listening", profile: PROFILE, micOn: false }));
  const field = () => s.host.querySelector<HTMLElement>("[data-conversation-field]")!;
  const word = () => field().querySelector<HTMLElement>("[data-voice-word]");
  const control = (name: string) => named(field().querySelector(".bk-voice-controls"), name) as HTMLButtonElement | null;
  const urgent = () => field().querySelector("[data-conversation-urgent]")!.textContent;
  expect(field().dataset.liveState).toBe("S5");
  const label = word();
  const step = async (state: string, change: Partial<ConversationClientState>, said: string) => {
    flushSync(() => client.state.setState(change));
    await expect.poll(() => field().dataset.liveState, { message: `reach ${state}` }).toBe(state);
    expect(word(), `${state}: the label is the one polite region, kept across states`).toBe(label);
    expect(label!.getAttribute("aria-live"), `${state}: the label is polite`).toBe("polite");
    expect(label!.textContent).toBe(said);
    if (state !== "L5") expect(last(s, "polite"), `${state} is announced`).toBe(said);
    if (state !== "L6") expect(urgent(), `${state}: nothing urgent`).toBe("");
    await still(state);
    await accessible(field(), `the live field in ${state}`);
  };
  expect(label?.getAttribute("aria-live")).toBe("polite");
  expect(label?.textContent).toBe("Connecting");
  await still("S5");
  await step("L1", { connection: "Connected", micOn: true }, "Listening");
  expect(document.activeElement, "the first mic-on puts focus on Mute").toBe(control("Mute"));
  await step("L2", { interaction: "Working" }, "Thinking");
  await step("L3", { work: { "ithaca-task": { state: "running" } as never } }, "Working");
  await step("L4", { work: {}, interaction: "Speaking", playing: true }, "Speaking");
  // Interrupt by keyboard. Once the reply stops it is disabled, and focus moves on to Mute rather than to the page.
  await tabTo(() => control("Interrupt"));
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => control("Interrupt")?.disabled).toBe(true);
  await expect.poll(() => document.activeElement, { message: "a disabled Interrupt hands focus to Mute" }).toBe(control("Mute"));
  flushSync(() => client.state.setState({ playing: false, interaction: "Listening" }));
  await step("L5", { outputRecovery: "checking" }, "Listening");
  await step("L1", { outputRecovery: "audible" }, "Listening");
  // An approval request is said at once, with how to answer it; the label stays polite.
  s.net.socket()!.deliver({ type: "tool_approval_request", sessionId: SESSION, turnId: "ithaca-turn", toolUseId: "ithaca-write", toolName: "Write", kind: "tool", input: { file_path: "voyage/raft.md", content: "Check the raft's lashings" } });
  await expect.poll(() => field().dataset.liveState, { message: "a pending approval is L6" }).toBe("L6");
  expect(label!.textContent).toBe("Needs your tap");
  expect(last(s, "polite")).toBe("Needs your tap");
  await expect.poll(() => last(s, "assertive"), { message: "L6 is assertive" }).toBe(urgent());
  expect(urgent()).toMatch(/^Tap Allow or Deny on the card\./);
  expect(field().querySelector("[data-conversation-urgent]")!.getAttribute("aria-live")).toBe("assertive");
  await still("L6");
  await accessible(field(), "the live field in L6");
  // Answered on screen, by keyboard.
  (page.getByRole("button", { name: /^Deny/ }).element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  expect(s.net.socket()!.frames("tool_denial")).toHaveLength(1);
  s.net.socket()!.deliver({ type: "tool_resolution", sessionId: SESSION, turnId: "ithaca-turn", toolUseId: "ithaca-write", outcome: "denied", channel: "card" });
  await expect.poll(() => field().dataset.liveState).not.toBe("L6");
  expect(urgent(), "the approval is answered").toBe("");
  await step("L7", { capture: "muted", micOn: false }, "Muted");
  await step("L8", { capture: "listening", connection: "Reconnecting" }, "Reconnecting…");
  // L9: a failure, assertive, replacing the field; focus moves from the gone control to Close.
  control("End")!.focus();
  flushSync(() => client.state.setState({ capture: "stopped", connection: "Speech lost", notice: "Speech connection lost. Start again when ready." }));
  await expect.poll(() => field().dataset.liveState).toBe("L9");
  const stopped = field().querySelector<HTMLElement>("[role=alert]");
  expect(stopped?.textContent).toBe("Live conversation stoppedSpeech connection lost. Start again when ready.");
  expect(last(s, "assertive"), "L9 is assertive").toBe("Live conversation stoppedSpeech connection lost. Start again when ready.");
  await expect.poll(() => document.activeElement, { message: "focus moves to the notice's first action" }).toBe(named(field(), "Close"));
  // Notice actions are in the tab order.
  await tabTo(() => named(field(), "Start again"));
  await tabTo(() => named(field(), "Close"), true);
  await still("L9");
  await accessible(field(), "the stopped notice");
  // The conversation ends, and focus returns to the mic.
  await userEvent.keyboard("{Enter}");
  expect(client.state.getState().active).toBe(false);
  await expect.poll(() => document.activeElement, { message: "ending returns focus to the mic" }).toBe(mic(s));
  expect(s.net.socket()!.frames("conversation_audio"), "no microphone was opened").toHaveLength(0);
});

test("live: End by keyboard returns focus to the mic", async ctx => {
  const s = await mount(ctx, false);
  const client = s.ui.connection.conversation;
  await expect.poll(() => client.state.getState().available).toBe(true);
  flushSync(() => client.enter());
  flushSync(() => client.state.setState({ disclosureOpen: false, sessionId: SESSION, connection: "Connected", capture: "listening", profile: PROFILE, micOn: true }));
  const field = () => s.host.querySelector<HTMLElement>("[data-conversation-field]")!;
  await expect.poll(() => document.activeElement).toBe(named(field(), "Mute"));
  await tabTo(() => named(field(), "End"));
  await userEvent.keyboard("{Enter}");
  expect(client.state.getState().active).toBe(false);
  await expect.poll(() => document.activeElement).toBe(mic(s));
});

/** A recognizer the test scripts, in place of the browser's. */
class ScriptedRecognition {
  static last: ScriptedRecognition | null = null;
  lang = ""; continuous = false; interimResults = false;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  constructor() { ScriptedRecognition.last = this; }
  start() { this.started = true; }
  stop() { queueMicrotask(() => this.onend?.()); }
  abort() {}
  hear(text: string) { this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text } }] }); }
}

test("dictation: D0, D3, D5, D7 and D8 by keyboard alone, announced, with notice actions in the tab order and nothing moving", async ctx => {
  vi.stubGlobal("SpeechRecognition", ScriptedRecognition);
  vi.stubGlobal("webkitSpeechRecognition", ScriptedRecognition);
  const s = await mount(ctx, true);
  const voice = () => s.ui.stores.voice.getState();
  const notice = () => s.host.querySelector<HTMLElement>("[data-dictation-notice]");
  const capture = () => s.host.querySelector<HTMLElement>("[data-dictation-field]");
  await expect.poll(() => mic(s)).not.toBe(null);
  textarea(s).focus();
  await tabTo(() => mic(s));
  await userEvent.keyboard("{Enter}");
  // D0 asks first, politely, with Start dictation focused.
  await expect.poll(() => notice()?.dataset.dictationNotice).toBe("D0");
  expect(notice()!.querySelector("[role=status]"), "D0 is polite").not.toBe(null);
  expect(document.activeElement).toBe(named(notice(), "Start dictation"));
  await still("D0");
  await accessible(notice(), "D0");
  await userEvent.keyboard("{Enter}");
  // D3: the label is a polite region; focus is on Finish dictation.
  await expect.poll(() => capture()?.dataset.dictationField).toBe("D3");
  const label = () => capture()!.querySelector("[data-voice-word]")!;
  expect(label().getAttribute("aria-live")).toBe("polite");
  await expect.poll(() => last(s, "polite"), { message: "Listening is announced" }).toBe("Listening");
  await expect.poll(() => document.activeElement).toBe(named(capture(), "Finish dictation"));
  ScriptedRecognition.last!.hear("Ask Penelope about the loom");
  await expect.poll(() => voice().finalText).toBe("Ask Penelope about the loom");
  await still("D3");
  await accessible(capture(), "D3");
  // D5, held while the words settle: announced, still, refusing Escape.
  flushSync(() => s.ui.stores.voice.setState({ draining: true }));
  expect(capture()!.dataset.dictationField).toBe("D5");
  await expect.poll(() => last(s, "polite")).toBe("Finishing");
  await still("D5");
  flushSync(() => s.ui.stores.voice.setState({ draining: false }));
  await tabTo(() => named(capture(), "Finish dictation"));
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => voice().mode).toBe("idle");
  await expect.poll(() => textarea(s).value).toBe("Ask Penelope about the loom");
  await expect.poll(() => document.activeElement, { message: "the words' end hands focus to the draft" }).toBe(textarea(s));

  // D7: a blocked microphone is a failure, said assertively.
  await tabTo(() => mic(s));
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => capture()?.dataset.dictationField).toBe("D3");
  ScriptedRecognition.last!.onerror?.({ error: "not-allowed" }); ScriptedRecognition.last!.onend?.();
  await expect.poll(() => notice()?.dataset.dictationNotice).toBe("D7");
  expect(notice()!.querySelector("[role=alert]"), "D7 is assertive").not.toBe(null);
  expect(last(s, "assertive")).toBe("Microphone is blockedAllow it in this site’s browser settings, then tap the mic again.");
  await still("D7");
  await accessible(notice(), "D7");
  await tabTo(() => named(notice(), "OK"), true);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => notice()).toBe(null);
  await expect.poll(() => document.activeElement).toBe(mic(s));

  // D8: a take that stops, keeping its words, is a failure too.
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => capture()?.dataset.dictationField).toBe("D3");
  ScriptedRecognition.last!.hear("and the harbour");
  await expect.poll(() => voice().finalText).toBe("and the harbour");
  ScriptedRecognition.last!.onerror?.({ error: "network" }); ScriptedRecognition.last!.onend?.();
  await expect.poll(() => notice()?.dataset.dictationNotice).toBe("D8");
  expect(notice()!.querySelector("[role=alert]"), "D8 is assertive").not.toBe(null);
  expect(last(s, "assertive")).toMatch(/^Dictation stopped/);
  await still("D8");
  await accessible(notice(), "D8");
  await tabTo(() => named(notice(), "Dismiss"), true);
  await tabTo(() => named(notice(), "Try again"));
  await tabTo(() => named(notice(), "Dismiss"), true);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => notice()).toBe(null);
  await expect.poll(() => document.activeElement).toBe(mic(s));
  expect(s.net.frames.filter(f => typeof f.data === "string" && f.data.includes("chat_message")), "nothing is sent").toEqual([]);
});
