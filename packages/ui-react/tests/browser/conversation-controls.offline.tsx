/// <reference types="@vitest/browser-playwright" />
import { afterAll, beforeAll, expect, test, vi, type TestContext } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CONVERSATION_LIMITS, type ServerConversationOpened, type ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { conversationProfileSchema, serverHelloSchema } from "@schlessera/brain-ui-sdk/schemas";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { AppShell } from "../../src/components/layout/app-shell.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { installFaultNetwork } from "./offline/fault-network.js";

const SESSION = "odysseus-ithaca";
const PROFILE: ServerConversationOpened = { type: "conversation_opened", conversationId: "ithaca-voice", epoch: 1, sessionId: SESSION, providerId: "gpt-live", capabilities: { nonblockingWork: "supported", manualEndpoint: "supported", finalTranscript: "unproven", remoteOutputCancelAck: "unproven", exactPermissionSpeech: "unproven", echoIsolatedInput: "unproven", outputWordAlignment: "unproven" }, disclosure: { voiceService: "Odysseus voice fixture", destinations: ["Audio and transcripts: fictional fixture. Retention: unknown."] }, limits: { ...CONVERSATION_LIMITS }, resync: { work: 0, outputs: 0 } };
const DISCLOSED_PROFILE = conversationProfileSchema.parse({providerId:PROFILE.providerId,capabilities:PROFILE.capabilities,disclosure:PROFILE.disclosure});
const HELLO = serverHelloSchema.parse({type:"server_hello",protocolRev:5,principalKey:"odysseus-principal",capabilities:{liveConversation:true,conversationPause:true,toolResolution:true},conversationProfile:DISCLOSED_PROFILE});
const LIVE_ATTACH = "Attach — live conversation, photo, camera, files";
let styles: HTMLStyleElement;
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());

/** Render real controls with inert state evidence; never opens a microphone or a provider. */
async function scene(ctx: TestContext, width: number, height: number, theme: "light" | "dark", scale = 1) {
  const viewport = { width: innerWidth, height: innerHeight };
  const outer = await commands.formViewport(width, height);
  await page.viewport(width, height);
  const network = installFaultNetwork({ routes: url => url.pathname.endsWith("/sessions") ? Response.json({ sessions: [] }) : undefined,
    onOpen(socket) { socket.deliver(HELLO); socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false }); socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] }); socket.deliver({ type: "status", sessionId: SESSION, status: "idle" }); } });
  const ui = createBrainUiRoot({ storage: null, request: network.request });
  ui.stores.chat.getState().setActiveSession(SESSION);
  ui.stores.ui.getState().setTheme(theme);
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;inset:0;width:${width}px;height:${height}px`;
  document.body.append(host);
  const renderer = createRoot(host);
  flushSync(() => renderer.render(<BrainUiProvider root={ui}><AppShell><ChatPage /></AppShell></BrainUiProvider>));
  const release = ui.connection.connect();
  ctx.onTestFinished(async () => { flushSync(() => renderer.unmount()); release(); ui.dispose(); network.restore(); host.remove(); await page.viewport(viewport.width, viewport.height); await commands.formViewport(outer.width - 100, outer.height - 120); });
  await expect.poll(() => ui.stores.connection.getState().wsStatus).toBe("connected");
  const client = ui.connection.conversation;
  const deliver = (message: ServerMessage) => network.socket()!.deliver(message);
  const capture = async (name: string) => { await page.screenshot({ element: host, path: `../../.vitest-attachments/conversation-controls/${theme}-${width}-${height}-${scale}-${name}.png` }); };
  const active = () => flushSync(() => client.state.setState({ active: true, sessionId: SESSION, connection: "Connected", capture: "listening", profile: PROFILE, disclosureOpen: false }));
  const strip = () => host.querySelector<HTMLElement>('[data-conversation-field]')!;
  const control = (name: string) => strip().querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  const word = () => strip().querySelector('[data-voice-word]')?.textContent;
  const controls = () => [...strip().querySelectorAll(".bk-voice-field button")].map(node => node.getAttribute("aria-label"));
  /** The connected clock ticks in real time; a baseline masks it, never the other meta. */
  const shot = () => ({ screenshotOptions: { mask: [...strip().querySelectorAll<HTMLElement>(".bk-voice-label-meta")].filter(node => /\d:\d\d$/.test(node.textContent ?? "")) } });
  /** The field holds its body and controls at 1× and doubled text (#3773), and every control takes its own taps. */
  const contained = (field: HTMLElement, what: string) => {
    expect(field.scrollHeight, `${what} cannot overlap the controls`).toBeLessThanOrEqual(field.clientHeight + 1);
    for (const control of field.querySelectorAll<HTMLElement>("button")) {
      const box = control.getBoundingClientRect();
      expect(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest("button"), `${what}: ${control.getAttribute("aria-label")} stays reachable`).toBe(control);
    }
  };
  /** Rows of the live surface other than the field itself and its screen-reader region (#3699: none). */
  const stacked = () => [...strip().children].filter(node => !node.classList.contains("sr-only") && !node.querySelector(".bk-voice-field") && node.tagName !== "DIALOG").map(node => node.outerHTML.slice(0, 80));
  if (scale !== 1) {
    // Text-only enlargement exercises wrapping independently of viewport zoom.
    const large = document.createElement("style"); large.textContent = `[data-conversation-field] { font-size:${12 * scale}px } [data-conversation-field] :is(div,button,[role=button]) { font-size:inherit !important; line-height:1.3 !important }`;
    document.head.append(large); ctx.onTestFinished(() => large.remove());
  }
  return { ui, client, host, deliver, capture, active, strip, control, controls, stacked, shot, contained, word, network, scale };
}

for (const theme of ["light", "dark"] as const) for (const [width, height, scale] of [[1280, 720, 1], [320, 568, 1], [320, 480, 2]] as const) test(`control audit ${theme} ${width}x${height} text ${scale}`, async ctx => {
  const s = await scene(ctx, width, height, theme, scale);
  s.active();
  for (const [name, connection, interaction, micOn, playing, capture, state] of [
    ["connecting", "Connecting", "Listening", false, false, "listening", "S5"],
    ["listening", "Connected", "Listening", true, false, "listening", "L1"],
    ["muted", "Connected", "Listening", false, false, "muted", "L7"],
    ["working", "Connected", "Working", true, false, "listening", "L2"],
    ["speaking", "Connected", "Speaking", false, true, "listening", "L4"],
    ["interruption", "Reconnecting", "Checking whether the reply stopped", false, false, "listening", "L8"],
    ["reconnect", "Speech lost", "Listening", false, false, "listening", "L8"],
    ["stopped", "Speech lost", "Listening", false, false, "stopped", "L9"],
  ] as const) {
    flushSync(() => s.client.state.setState({ connection, interaction, micOn, playing, capture, notice: name === "reconnect" || name === "stopped" ? "Speech connection lost. Resume when ready." : "" }));
    expect(s.strip().dataset.liveState, name).toBe(state);
    // Pin keyboard modality and focus; earlier test input must not change a baseline's ring.
    if (name === "interruption") { s.control("Mute").focus(); await userEvent.keyboard("{ArrowRight}"); }
    await s.capture(name);
    if (name === "interruption" && width === 320) await expect(page.elementLocator(s.strip())).toMatchScreenshot(`interruption-${theme}-${scale}`, s.shot());
    const field = s.strip().querySelector<HTMLElement>(".bk-voice-field")!;
    s.contained(field, name);
    expect(s.strip().scrollWidth, `${name}: no horizontal overflow`).toBeLessThanOrEqual(s.strip().clientWidth);
    for (const control of s.strip().querySelectorAll<HTMLElement>('button,[role=button]')) {
      expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      expect(control.scrollWidth, `${name}: full control label`).toBeLessThanOrEqual(control.clientWidth + 1);
    }
  }
  flushSync(() => s.client.state.setState({ connection: "Connected", capture: "listening", interaction: "Review before sending", micOn: false, notice: "", text: "Ask Nestor about the departure, the harbour supplies and the next meeting before sailing." }));
  s.deliver({ type: "text_delta", sessionId: SESSION, turnId: "ithaca-turn", text: "The departure note needs review." });
  s.deliver({ type: "tool_approval_request", sessionId: SESSION, turnId: "ithaca-turn", toolUseId: "ithaca-write", toolName: "Write", kind: "tool", input: { file_path: "voyage/raft.md", content: "Review the raft supplies" } });
  await expect.poll(() => s.host.querySelector('[data-approval-card]')).not.toBe(null);
  await expect.poll(() => s.strip().dataset.liveState, { message: "a pending approval card is L6" }).toBe("L6");
  s.control("Mute").focus(); await userEvent.keyboard("{ArrowRight}");
  await s.capture("review-permission");
  if (width === 320) await expect(page.elementLocator(s.strip())).toMatchScreenshot(`review-permission-${theme}-${scale}`, s.shot());
  // Nothing stacks above the field: the draft holds its body, the refusal window marks the field (#3699).
  expect(s.strip().hasAttribute("data-voice-refusal-window"), "the refusal window is open").toBe(true);
  expect(s.stacked(), "no row renders above the field").toEqual([]);
  expect(s.strip().querySelector(".bk-voice-label-meta")?.textContent).toBe("Draft · not sent yet");
  expect(s.strip().querySelector('[data-conversation-review]')?.textContent).toBe("Ask Nestor about the departure, the harbour supplies and the next meeting before sailing.");
  expect(s.controls(), "R1 and L6_NO_VOICE_GRANT: a held draft replaces Interrupt; nothing grants").toEqual(["Mute", "Discard draft", "Send now", "End"]);
  const voiceField = s.strip().querySelector<HTMLElement>(".bk-voice-field")!;
  s.contained(voiceField, "the draft");
  flushSync(() => s.client.state.setState({ micOn: true })); s.client.permissions.refresh();
  expect(s.client.permissions.state.getState().line).not.toContain("brain, stop");
  flushSync(() => s.client.state.setState({ micOn: false }));
  expect(s.client.permissions.state.getState().records[0]?.script).not.toContain("unmute to refuse");
  page.getByRole("button", { name: "Send now", exact: true }).element().focus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement, "the keyboard reaches Discard draft before Send now").toBe(s.control("Discard draft"));
  // Without a draft, the refusal line is the body (L6), with nothing to say to approve.
  const held = s.client.state.getState().text;
  flushSync(() => s.client.state.setState({ text: "" }));
  expect(s.strip().querySelector("[data-voice-text]")?.textContent).toBe("Tap Allow or Deny on the card. Voice can’t approve or refuse with this service.");
  expect(s.strip().textContent).not.toContain("unmute to refuse");
  expect(s.controls()).toEqual(["Mute", "Interrupt", "End"]);
  s.contained(voiceField, "the refusal line");
  flushSync(() => s.client.state.setState({ text: held }));
  await userEvent.click(page.getByRole("button", { name: /^Deny/ }));
  expect(s.network.socket()!.frames("tool_denial")).toHaveLength(1);
  expect(s.network.socket()!.frames("tool_denial")[0]?.channel).toBe("card");
  for (const outcome of ["denied", "expired"] as const) {
    s.deliver({ type: "tool_resolution", sessionId: SESSION, turnId: "ithaca-turn", toolUseId: "ithaca-write", outcome, channel: "card" });
    await expect.poll(() => s.host.querySelector('[data-approval-card]')).toBe(null);
    await s.capture(outcome);
  }
  flushSync(() => s.client.state.setState({ disclosureOpen: true, micOn: false }));
  await s.capture("disclosure");
  expect(document.body.textContent).not.toContain("Refusal by voice needs headphones");
  expect(document.body.textContent).toContain("Spoken refusal is unavailable");
  const dialog = document.querySelector<HTMLElement>('[data-overlay-site="conversation-disclosure"]')!;
  for (const name of ["Start", "Cancel"]) {
    const control = [...dialog.querySelectorAll<HTMLElement>('button,[role=button]')].find(node => node.textContent === name)!;
    expect(control.getBoundingClientRect().right, `${name} fits inside disclosure`).toBeLessThanOrEqual(dialog.getBoundingClientRect().right);
  }
  await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
  expect(s.client.state.getState().active).toBe(false);
  expect(s.network.socket()!.frames("conversation_audio")).toHaveLength(0);
});

for (const theme of ["light", "dark"] as const) test(`entry and connecting disclosure ${theme}`, async ctx => {
  const s = await scene(ctx, 1280, 720, theme);
  await userEvent.click(page.getByRole("button", { name: LIVE_ATTACH, exact: true }));
  await s.capture("entry");
  await userEvent.click(page.getByRole("button", { name: /Live conversation/ }));
  await expect.poll(() => s.client.state.getState().disclosureOpen).toBe(true);
  await s.capture("connecting-disclosure");
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.network.socket()!.frames("conversation_start"),"ENTRY_DISCLOSES_WITHOUT_OPENING_PROVIDER").toHaveLength(0);
  const start=page.getByRole("button",{name:"Start",exact:true});
  expect(start.element().getAttribute("aria-disabled"),"KNOWN_DISCLOSURE_ALLOWS_EXPLICIT_START").not.toBe("true");
  expect(document.querySelector('[data-overlay-site="conversation-disclosure"]')!.contains(document.activeElement),"ENTRY_DISCLOSURE_OWNS_FOCUS").toBe(true);
  await userEvent.click(start);
  expect(s.network.socket()!.frames("conversation_start")).toHaveLength(1);
  expect(s.network.socket()!.frames("conversation_start")[0]!.disclosed).toEqual(DISCLOSED_PROFILE);
  expect(s.client.state.getState().connection,"PROVIDER_OPENING_IS_STILL_PENDING").toBe("Connecting");
  expect(s.client.state.getState().profile).toBe(null);expect(s.client.state.getState().micOn).toBe(false);
  expect(s.strip().dataset.liveState, "a pending opening draws Connecting (S5)").toBe("S5");
  expect(s.control("Mute").disabled, "nothing to mute while connecting").toBe(true);
  flushSync(() => s.client.details());
  await expect.poll(()=>s.client.state.getState().disclosureOpen).toBe(true);
  await s.capture("pending-connecting-disclosure");
  // A known destination is not enough when the host connection is unavailable.
  flushSync(()=>s.ui.stores.connection.setState({wsStatus:"disconnected"}));
  expect(page.getByRole("button",{name:"Start",exact:true}).element().getAttribute("aria-disabled")).toBe("true");
  expect(s.network.socket()!.frames("conversation_start"),"PENDING_OPENING_DOES_NOT_REPEAT").toHaveLength(1);
  await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
  expect(s.client.state.getState().active).toBe(false);
});

// #3045: the paperclip names live conversation, and a pointer can read that
// name as a tooltip; a touch screen reads it in the attach sheet instead.
for (const theme of ["light", "dark"] as const) for (const [width, height] of [[1280, 720], [320, 568]] as const) test(`entry is named from the paperclip ${theme} ${width}x${height}`, async ctx => {
  const s = await scene(ctx, width, height, theme);
  const trigger = () => page.getByRole("button", { name: /^Attach — / }).element() as HTMLElement;
  const tip = () => trigger().querySelector<HTMLElement>("[data-composer-tip]")!;
  const shown = () => getComputedStyle(tip()).display !== "none" && getComputedStyle(tip()).visibility === "visible";
  const field = () => trigger().closest<HTMLElement>(".bk-field")!;
  const textarea = () => s.host.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
  await expect.poll(() => s.client.state.getState().available).toBe(true);

  // Available: one string is the accessible name and the painted tooltip.
  await expect.element(page.getByRole("button", { name: LIVE_ATTACH, exact: true })).toBeInTheDocument();
  expect(tip().textContent).toBe(LIVE_ATTACH);
  expect(tip().getAttribute("aria-hidden")).toBe("true");
  expect(shown(), "no tooltip at rest").toBe(false);

  // Keyboard: focus shows it at once, Escape hides it and keeps focus, Enter opens the menu.
  textarea().focus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement).toBe(trigger());
  expect(shown(), "keyboard focus shows the tooltip immediately").toBe(true);
  expect(getComputedStyle(field()).outlineStyle, "the field keeps its ring").not.toBe("none");
  const box = tip().getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.right, "the tooltip stays inside the viewport").toBeLessThanOrEqual(width);
  expect(box.bottom, "the tooltip clears the field").toBeLessThanOrEqual(field().getBoundingClientRect().top);
  expect(tip().scrollWidth, "the whole name is painted").toBeLessThanOrEqual(tip().clientWidth + 1);
  await s.capture("attach-focus-tooltip");
  await userEvent.keyboard("{Escape}");
  expect(shown(), "Escape dismisses the tooltip").toBe(false);
  expect(document.activeElement, "Escape leaves focus on the trigger").toBe(trigger());
  expect(s.client.state.getState().disclosureOpen).toBe(false);
  await userEvent.keyboard("{Enter}");
  if (width >= 900) await expect.element(page.getByRole("menu", { name: "Attach" })).toBeInTheDocument();
  else {
    // A phone's sheet names the option in its subtitle; its row is a full target.
    await expect.poll(() => document.querySelector('[data-overlay-site="attach"]')).not.toBe(null);
    expect(document.querySelector('[data-overlay-site="attach"]')!.textContent).toContain("Live conversation, photo, camera, track files, or paste.");
    expect((page.getByRole("button", { name: /^Live conversation/ }).element() as HTMLElement).getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await s.capture("attach-sheet");
  }
  expect(shown(), "an opened menu hides the tooltip").toBe(false);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector('[data-overlay-site="attach"],[role="menu"]')).toBe(null);
  // The sheet hands focus back to its trigger once it has closed.
  if (width < 900) await expect.poll(() => document.activeElement).toBe(trigger());
  textarea().focus();

  // Pointer hover: hidden until the 400ms delay, then readable and hoverable.
  // Park the real mouse on the field first: an earlier scene can leave it here.
  await userEvent.hover(textarea());
  expect(trigger().matches(":hover") || trigger().matches(":focus-visible")).toBe(false);
  await expect.poll(shown).toBe(false);
  await userEvent.hover(trigger());
  expect(shown(), "hover waits before showing the tooltip").toBe(false);
  await expect.poll(shown, { timeout: 2000 }).toBe(true);
  await s.capture("attach-hover-tooltip");
  await userEvent.hover(tip());
  // A tip that lost its host's hover runs its 150 ms visibility transition to
  // hidden. Reading the style starts any such transition; await it to the end.
  void getComputedStyle(tip()).visibility;
  await Promise.all(tip().getAnimations().map(animation => animation.finished));
  expect(shown(), "the pointer can rest on the tooltip").toBe(true);
  await userEvent.keyboard("{Escape}");
  expect(shown(), "Escape dismisses a hover tooltip without moving the pointer").toBe(false);
  await userEvent.unhover(trigger());

  // Not available: the name and the menu leave live conversation out.
  flushSync(() => s.client.state.setState({ available: false }));
  await expect.element(page.getByRole("button", { name: "Attach — photo, camera, files", exact: true })).toBeInTheDocument();
  expect(tip().textContent).toBe("Attach — photo, camera, files");
  await userEvent.click(trigger());
  expect(document.body.textContent).not.toContain("Live conversation");
  await s.capture("attach-inactive-menu");
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => document.querySelector('[data-overlay-site="attach"],[role="menu"]')).toBe(null);
  flushSync(() => s.client.state.setState({ available: true }));
  await expect.element(page.getByRole("button", { name: LIVE_ATTACH, exact: true })).toBeInTheDocument();

  await userEvent.click(trigger());
  await userEvent.click(page.getByRole("button", { name: /^Live conversation/ }));
  // The entry still leads to the first-entry disclosure; nothing opens a provider or a microphone.
  await expect.poll(() => s.client.state.getState().disclosureOpen).toBe(true);
  expect(s.client.state.getState().micOn).toBe(false);
  expect(s.network.socket()!.frames("conversation_start"), "ENTRY_DISCLOSES_WITHOUT_OPENING_PROVIDER").toHaveLength(0);
  expect(s.network.socket()!.frames("conversation_audio")).toHaveLength(0);
  await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
  expect(s.client.state.getState().active).toBe(false);
});

// Capture/readiness diagnostics remain actionable alongside an unsent draft.
// The body holds one message: draft → refusal → output muted → client notice (#3699).
for (const theme of ["light", "dark"] as const) for (const [width, height, scale] of [[1280, 720, 1], [320, 568, 1], [320, 480, 2]] as const) test(`notice with review ${theme} ${width}x${height} text ${scale}`, async ctx => {
  const s = await scene(ctx, width, height, theme, scale);
  s.active();
  const text = "Ask Nestor to review the harbour supplies before sailing.";
  flushSync(() => s.client.state.setState({ micOn: false, text, interaction: "Review before sending" }));
  flushSync(() => s.client.state.setState({ connection: "Speech lost" }));
  const mute = s.control("Mute");
  const body = () => s.strip().querySelector("[data-voice-text]")?.textContent;
  const meta = () => s.strip().querySelector(".bk-voice-label-meta")?.textContent;
  const field = () => s.strip().querySelector<HTMLElement>(".bk-voice-field")!;
  for (const [notice, line, qualifier] of [
    ["Microphone input ended. Check the device, then resume.", "Microphone input ended. Check the device, then resume.", undefined],
    ["Waiting for voice readiness. Microphone off.", "Waiting for voice to be ready. Nothing is heard until then.", "mic off"],
    ["Synchronizing voice. Microphone off.", "Waiting for voice to be ready. Nothing is heard until then.", "mic off"],
    ["Microphone off while checking the reply stop. Resume when voice is ready.", "Microphone off while checking the reply stop. Resume when voice is ready.", undefined],
    ["Speech input could not be matched to captured audio. Microphone off; review before resuming.", "Speech input could not be matched to captured audio. Microphone off; review before resuming.", undefined],
  ] as const) {
    flushSync(() => s.client.state.setState({ connection: "Speech lost", notice, text }));
    mute.focus();
    expect(s.strip().dataset.liveState, "a recoverable loss with retained consent is Reconnecting").toBe("L8");
    expect(body(), "the held draft outranks a client notice").toBe(text);
    expect(meta()).toBe("Draft · not sent yet");
    expect(s.strip().textContent?.includes(notice), "one message at a time").toBe(false);
    flushSync(() => s.client.state.setState({ text: "" }));
    expect(body(), notice).toBe(line);
    if (qualifier) expect(meta(), "readiness says the microphone is off").toBe(qualifier);
    else expect(meta()).toMatch(/^GPT-Live · \d+:\d\d$/);
    expect(s.control("Mute").disabled, "nothing to mute while voice is not ready").toBe(!!qualifier);
    if (!qualifier) expect(document.activeElement, "a notice must not steal focus").toBe(mute);
    s.contained(field(), notice);
    expect(s.strip().scrollWidth).toBeLessThanOrEqual(s.strip().clientWidth);
    expect(s.stacked(), "no row renders above the field").toEqual([]);
  }
  await s.capture("notice");
  if (width === 320 && scale === 1) await expect(page.elementLocator(s.strip())).toMatchScreenshot(`notice-body-${theme}`, s.shot());
  // Unclear audio without a calibrated score: its line is the draft's body.
  flushSync(() => s.client.state.setState({ connection: "Connected", notice: "I couldn't hear that clearly. Review before sending.", text }));
  expect(body()).toBe("I couldn't hear that clearly. Review before sending.");
  expect(meta()).toBe("Draft · not sent yet");
  expect(s.controls()).toEqual(["Mute", "Discard draft", "Send now", "End"]);
  // Reply audio off outranks a client notice and keeps Recover in the row, even under a draft.
  flushSync(() => s.client.state.setState({ outputRecovery: "muted", notice: "Reply audio is muted. Recover reply audio to listen; the microphone is unchanged." }));
  expect(body(), "the draft still outranks it").toBe(text);
  expect(s.controls(), "Recover stays while reply audio is off").toEqual(["Mute", "Recover reply audio", "Discard draft", "Send now", "End"]);
  for (const control of s.strip().querySelectorAll<HTMLElement>("button")) {
    expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(control.getBoundingClientRect().right).toBeLessThanOrEqual(field().getBoundingClientRect().right + 0.5);
  }
  await s.capture("output-muted-draft");
  if (width === 320 && scale === 1) await expect(page.elementLocator(s.strip())).toMatchScreenshot(`output-muted-draft-${theme}`, s.shot());
  flushSync(() => s.client.state.setState({ text: "" }));
  expect(body()).toBe("Brain’s voice was paused after a dropout. Replies still arrive as text.");
  expect(meta()).toBe("Reply audio off");
  expect(s.controls()).toEqual(["Mute", "Recover reply audio", "End"]);
  await s.capture("output-muted");
  flushSync(() => s.client.state.setState({ outputRecovery: "audible", notice: "" }));
  expect(s.strip().querySelector("[data-voice-text]"), "no message, no body").toBe(null);
  expect(s.strip().querySelector('[role="status"]')).toBe(null);
});

// PCM scheduling gaps must not move a pointer target or flash the displayed state.
for (const theme of ["light", "dark"] as const) for (const [width, height, scale] of [[1280, 720, 1], [320, 568, 1], [320, 480, 2]] as const) test(`reply windows keep controls stable ${theme} ${width}x${height} text ${scale}`, async ctx => {
  const s = await scene(ctx, width, height, theme, scale);
  s.active();
  // No draft: R1 moves Interrupt out of a draft's row outside L4, which the field tests cover.
  flushSync(() => s.client.state.setState({ text: "", interaction: "Review before sending", micOn: true, notice: "spoken portion unknown" }));
  const names = ["Mute", "Interrupt", "End"];
  const controls = () => names.map(name => s.control(name));
  expect(s.control("Interrupt"), "Interrupt keeps its place before playback starts").not.toBe(null);
  const targets = controls();
  const bounds = targets.map(node => node.getBoundingClientRect());
  expect(targets[1].disabled, "Interrupt is disabled outside L4").toBe(true);
  for (const box of bounds) { expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44); }
  // The strip holds Speaking for 300 ms after playback stops. That timer runs
  // on a fake clock, so each gap is exact rather than a real wait.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); ctx.onTestFinished(() => { vi.useRealTimers(); });
  for (const gap of [10, 40, 100, 20]) {
    flushSync(() => s.client.state.setState({ playing: true, interaction: "Speaking" }));
    await expect.poll(() => s.control("Interrupt").disabled).toBe(false);
    targets[0].focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement, "Tab reaches Interrupt in its stable slot").toBe(targets[1]);
    flushSync(() => s.client.state.setState({ playing: false, interaction: gap === 40 ? "Listening" : "Review before sending" }));
    flushSync(() => vi.advanceTimersByTime(gap));
    expect(s.word(), "short PCM gaps retain Speaking feedback").toBe("Speaking");
    expect(s.client.state.getState().micOn, "display smoothing must not mute or resume capture").toBe(true);
    expect(s.client.state.getState().playing, "presentation must not alter sample-level state").toBe(false);
    expect(targets[1].disabled, "Interrupt remains available across a short gap").toBe(false);
    controls().forEach((node, index) => {
      const box = node.getBoundingClientRect();
      expect([box.x, box.y, box.width, box.height], "control geometry stays fixed across PCM windows").toEqual([bounds[index].x, bounds[index].y, bounds[index].width, bounds[index].height]);
      expect(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest('button,[role="button"]'), "original target center still hits the same action").toBe(targets[index]);
      expect(node.scrollWidth).toBeLessThanOrEqual(node.clientWidth + 1);
    });
    expect(document.activeElement).toBe(targets[1]);
  }
  await s.capture("reply-gap");
  flushSync(() => vi.runOnlyPendingTimers());
  vi.useRealTimers();
  await expect.poll(() => targets[1].disabled).toBe(true);
  expect(s.word()).toBe("Listening");
  flushSync(() => s.client.state.setState({ playing: true, interaction: "Speaking" }));
  flushSync(() => s.client.state.setState({ playing: false, interaction: "Review before sending" }));
  flushSync(() => s.client.state.setState({ connection: "Speech lost", notice: "Speech connection lost. Resume when ready." }));
  expect(s.word(), "connection loss is never smoothed away").toBe("Reconnecting…");
  expect(targets[1].disabled).toBe(true);
  flushSync(() => s.client.state.setState({ connection: "Connected", notice: "", playing: true, interaction: "Speaking" }));
  flushSync(() => s.client.state.setState({ playing: false, interaction: "Review before sending" }));
  targets[0].focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(targets[1]);
  await userEvent.keyboard("{Enter}");
  expect(s.client.state.getState().outputRecovery).not.toBe("audible");
  expect(s.word(), "explicit output stop takes precedence immediately").not.toBe("Speaking");
  expect(targets[1].disabled).toBe(true);
  expect(s.client.state.getState().micOn, "Interrupt preserves microphone intent").toBe(true);
  expect(s.network.socket()!.frames("conversation_audio")).toHaveLength(0);
  expect(s.network.socket()!.frames("conversation_commit")).toHaveLength(0);
});
