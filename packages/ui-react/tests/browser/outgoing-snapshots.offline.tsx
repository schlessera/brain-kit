/// <reference types="@vitest/browser-playwright" />
/**
 * Outgoing snapshots in Chromium (#3155, design brief rev 5 §2–§5 cases
 * 22–28, rev 4 case 6). The real Composer, the real snapshot bubbles and the
 * real draft client run against the fixture host in `../snapshot-host.ts`,
 * which keeps #3153's and #3588's rules in memory: If-Match, the whole
 * snapshot list on every save, the chat-wide limit of ten counted across
 * every draft of the session, the allowed state moves, and acceptance that
 * releases one snapshot in place. A "reload" is a new root against the same
 * host. No key, no network.
 */
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { Composer } from "../../src/components/chat/composer.js";
import { OutgoingSnapshots } from "../../src/components/chat/outgoing-snapshots.js";
import { UnconfirmedSends } from "../../src/components/chat/unconfirmed-sends.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { SESSION, snapshotHost, type SnapshotHost } from "../snapshot-host.js";

class FixtureSocket {
  static last: FixtureSocket | undefined;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror = null;
  sent: string[] = [];
  constructor() { FixtureSocket.last = this; }
  send(raw: string) { this.sent.push(raw); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  deliver(frame: unknown) { flushSync(() => this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)); }
}

const scenes: { host: HTMLDivElement; renderer: Root; root: BrainUiRoot; disposed: boolean }[] = [];
let styles: HTMLStyleElement;
let viewport: { width: number; height: number };
beforeAll(async () => {
  viewport = { width: window.innerWidth, height: window.innerHeight };
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
/** The offline lane has no network, so `navigator.onLine` is false; the fixture host is reachable. Restored whole. */
let onLine: PropertyDescriptor | undefined | null = null;
function emulateOnline() {
  if (onLine === null) onLine = Object.getOwnPropertyDescriptor(navigator, "onLine");
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
}
function restoreOnline() {
  if (onLine === null) return;
  if (onLine) Object.defineProperty(navigator, "onLine", onLine);
  else Reflect.deleteProperty(navigator, "onLine");
  onLine = null;
}
afterEach(() => {
  for (const s of scenes.splice(0)) if (!s.disposed) { flushSync(() => s.renderer.unmount()); s.root.dispose(); s.host.remove(); }
  vi.unstubAllGlobals();
  restoreOnline();
});
afterAll(async () => { styles.remove(); await page.viewport(viewport.width, viewport.height); });

const HELLO = {
  type: "server_hello", protocolRev: 5,
  capabilities: { sessionDrafts: true, chatRequestAck: true, composerFiles: true, sessionRecovery: true },
  attachmentLimits: { maxFiles: 10, maxFileBytes: 25_000_000, maxTotalBytes: 50_000_000, poolBytes: 1_073_741_824 },
  sessionDraftLimits: { maxTextBytes: 65_536, maxDraftBytes: 8_388_608, maxDrafts: 100, maxTotalBytes: 268_435_456, maxOutgoingSnapshots: 10 },
};

async function mount(fixture: SnapshotHost, width = 1280, height = 900) {
  await page.viewport(width, height);
  emulateOnline();
  const root = createBrainUiRoot({ storage: null, request: fixture.request });
  vi.stubGlobal("WebSocket", FixtureSocket);
  root.stores.chat.getState().setActiveSession(SESSION);
  root.connection.connect();
  const socket = FixtureSocket.last!;
  flushSync(() => socket.open());
  socket.deliver(HELLO);
  socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false });
  socket.deliver({ type: "session_history", sessionId: SESSION, messages: [] });
  socket.deliver({ type: "status", sessionId: SESSION, status: "idle" });
  const host = document.createElement("div"); document.body.append(host);
  const renderer = createRoot(host);
  const scene = { host, renderer, root, disposed: false };
  scenes.push(scene);
  flushSync(() => renderer.render(<BrainUiProvider root={root}>
    <div data-transcript=""><OutgoingSnapshots /><UnconfirmedSends /></div>
    <Composer send={(msg) => root.connection.send(msg)} />
  </BrainUiProvider>));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const field = () => host.querySelector<HTMLTextAreaElement>("[data-composer] textarea")!;
  const sendButton = () => host.querySelector<HTMLElement>('[data-composer] [aria-label^="Send"]')!;
  const bubbles = () => [...host.querySelectorAll<HTMLElement>("[data-outgoing-snapshot]")];
  const bubble = (text: string) => bubbles().find((b) => b.querySelector(".chat-message-body")?.textContent === text);
  const messages = () => socket.sent.map((raw) => JSON.parse(raw) as ClientMessage).filter((f): f is Extract<ClientMessage, { type: "chat_message" }> => f.type === "chat_message");
  const draft = () => { const s = root.stores.drafts.getState(); return s.drafts[s.idFor(SESSION)]; };
  /** Every non-empty text the snapshot live region took, in order. */
  const spoken: string[] = [];
  // The region is portaled out of the transcript (#1013): this mount's is the newest in the body.
  const region = [...document.querySelectorAll("[data-snapshot-announcement]")].at(-1);
  if (region) new MutationObserver(() => { if (region.textContent) spoken.push(region.textContent); }).observe(region, { childList: true, characterData: true, subtree: true });
  const reload = () => { flushSync(() => renderer.unmount()); root.dispose(); host.remove(); scene.disposed = true; };
  return { root, host, socket, field, sendButton, bubbles, bubble, messages, draft, spoken, reload };
}
type Scene = Awaited<ReturnType<typeof mount>>;

/** A kit Button in `scope` whose own label is exactly `label`. */
function action(scope: Element, label: string): HTMLElement | undefined {
  return [...scope.querySelectorAll<HTMLElement>("[data-bk-button]")].find((b) => [...b.querySelectorAll(":scope > span")].some((s) => s.firstChild?.textContent === label));
}
const indicatorName = (b: Element) => b.querySelector(".bk-status-indicator-btn")?.getAttribute("aria-label") ?? null;
const heading = (b: Element) => b.querySelector<HTMLElement>("[data-snapshot-heading]")!;
function pickFiles(s: Scene, files: File[]) {
  const input = s.host.querySelector<HTMLInputElement>("input[data-files-input]")!;
  const transfer = new DataTransfer(); for (const file of files) transfer.items.add(file);
  input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
}
const crewList = () => new File(["Eurylochus\nPolites\nElpenor\n"], "crew-list.txt", { type: "text/plain" });
const chart = () => new File(["Scylla to port, Charybdis to starboard\n"], "strait-chart.txt", { type: "text/plain" });
const typed = async (s: Scene, text: string) => { await userEvent.fill(s.field(), text); };
/** The host holds the snapshot: the field takes newer words again (a refusal can no longer give text back). */
const acknowledged = (fixture: SnapshotHost, s: Scene, text: string) =>
  expect.poll(() => fixture.snapshotsOf(s.draft()!.draftId).some((x) => x.text === text) && !!s.draft()!.host?.snapshots?.some((x) => x.text === text), { timeout: 5_000 }).toBe(true);
const saved = (s: Scene) => { const d = s.draft(); return !!d && d.host !== null && d.host.edit === d.edit; };
const FULL = "10 messages in this chat are waiting or need recovery. Send, cancel or delete one, then send this. Your text stays here.";

test("case 22: at ten snapshots Send is refused with nothing sent and the text kept; Cancel and Delete… still work, and freeing a slot clears the notice", async () => {
  const fixture = snapshotHost();
  fixture.seed("draft-ithaca", [
    { snapshotId: "held-1", requestId: "r-held-1", text: "Wait for the west wind.", state: "held" },
    ...Array.from({ length: 9 }, (_, i) => ({ snapshotId: `ret-${i}`, requestId: `r-ret-${i}`, text: `Oar stroke ${i + 1}.`, state: "returned" as const })),
  ]);
  const s = await mount(fixture);
  await expect.poll(() => s.bubbles().length).toBe(10);
  const held = s.bubble("Wait for the west wind.")!;
  expect(heading(held).textContent).toBe("Paused after reload · files stored");
  expect(indicatorName(held)).toBe("Message 1 of 10: Paused after reload · files stored. Details.");
  for (const b of s.bubbles()) expect(indicatorName(b), "no message text in the indicator's name").not.toMatch(/Oar|wind/);
  await typed(s, "Turn the ship for Aeaea.");
  await expect.poll(() => saved(s), { timeout: 5_000 }).toBe(true);
  // Typing while the creating save is out cannot reach the field, so a
  // refusal gives the text back alone: never joined to newer words.
  const release = fixture.holdSaves();
  s.sendButton().click();
  await expect.poll(() => s.field().value).toBe("");
  await userEvent.type(s.field(), "and more");
  expect(s.field().value, "no edit while the snapshot is unacknowledged").toBe("");
  const before = document.activeElement;
  release();
  await expect.poll(() => s.host.querySelector("[data-outgoing-full]")?.textContent ?? "", { timeout: 5_000 }).toContain(FULL);
  expect(s.messages(), "no chat_message").toHaveLength(0);
  expect(fixture.saves.some((x) => x.status === 409), "the creating save was refused").toBe(true);
  expect(s.field().value, "the text stays here").toBe("Turn the ship for Aeaea.");
  expect(s.sendButton().getAttribute("aria-disabled")).toBe("true");
  expect(document.activeElement, "focus unchanged").toBe(before);
  expect(fixture.count()).toBe(10);
  // Show reaches the oldest snapshot that needs action.
  action(s.host.querySelector("[data-outgoing-full]")!, "Show")!.click();
  expect(document.activeElement).toBe(heading(s.bubbles()[0]!));
  // Cancel needs no free slot: it changes the held one in place, at 10 of 10.
  action(held, "Cancel")!.click();
  await expect.poll(() => fixture.snapshotsOf("draft-ithaca").find((x) => x.snapshotId === "held-1")?.state, { timeout: 5_000 }).toBe("returned");
  expect(fixture.count()).toBe(10);
  expect(document.activeElement).toBe(heading(s.bubble("Wait for the west wind.")!));
  expect(s.spoken.at(-1)).toBe("Not sent. Kept as its own message.");
  expect(s.host.querySelector("[data-outgoing-full]"), "still full").not.toBeNull();
  // Delete… frees a slot from this tab: the notice goes and Send works again.
  action(s.bubble("Oar stroke 1.")!, "Delete…")!.click();
  await expect.poll(() => document.querySelector("[data-snapshot-delete]")).not.toBeNull();
  action(document.querySelector("[data-snapshot-delete]")!, "Delete")!.click();
  await expect.poll(() => fixture.count(), { timeout: 5_000 }).toBe(9);
  await expect.poll(() => s.host.querySelector("[data-outgoing-full]")).toBeNull();
  expect(s.sendButton().getAttribute("aria-disabled")).toBeNull();
});

test("case 23: two devices at nine snapshots send at the same moment and exactly one is admitted", async () => {
  const fixture = snapshotHost();
  const a = await mount(fixture);
  const b = await mount(fixture);
  fixture.seed("draft-third-device", Array.from({ length: 9 }, (_, i) => ({ snapshotId: `t-${i}`, requestId: `rt-${i}`, text: `Ithaca beacon ${i + 1}.`, state: "returned" as const })));
  await typed(a, "Device one: lower the sail.");
  await typed(b, "Device two: raise the sail.");
  await expect.poll(() => saved(a) && saved(b), { timeout: 5_000 }).toBe(true);
  expect(a.draft()!.draftId).not.toBe(b.draft()!.draftId);
  a.sendButton().click();
  b.sendButton().click();
  await expect.poll(() => fixture.saves.filter((x) => x.body.snapshots?.length && (x.status === 200 || x.status === 409)).length, { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => a.messages().length + b.messages().length, { timeout: 5_000 }).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(a.messages().length + b.messages().length, "exactly one admitted").toBe(1);
  expect(fixture.count()).toBe(10);
  const refused = a.messages().length === 1 ? b : a;
  expect(refused.host.querySelector("[data-outgoing-full]")?.textContent).toContain(FULL);
  expect(refused.field().value).toMatch(/^Device (one|two)/);
});

test("case 24 and rev 4 case 6: held, returned and a newer draft stay separate; only the snapshot is sent; Edit waits for an empty composer", async () => {
  const fixture = snapshotHost();
  const s = await mount(fixture, 320, 700);
  const release = fixture.holdUploads();
  await typed(s, "Chart the strait.");
  pickFiles(s, [chart()]);
  await expect.poll(() => fixture.uploads.length).toBe(1);
  s.sendButton().click();
  await expect.poll(() => s.bubble("Chart the strait.") ? heading(s.bubble("Chart the strait.")!).textContent : null).toBe("Held · sends when 1 file is stored");
  expect(s.field().value, "Send cleared the composer").toBe("");
  expect(s.host.querySelectorAll("[data-file-chip]"), "the upload is the snapshot's now").toHaveLength(0);
  await expect.poll(() => fixture.snapshotsOf(s.draft()!.draftId).length, { timeout: 5_000 }).toBe(1);
  expect(fixture.snapshotsOf(s.draft()!.draftId)[0]!.state).toBe("held");
  action(s.bubble("Chart the strait.")!, "Cancel")!.click();
  await expect.poll(() => heading(s.bubble("Chart the strait.")!).textContent).toBe("Not sent · cancelled");
  await typed(s, "Read the crew list aloud.");
  pickFiles(s, [crewList()]);
  await expect.poll(() => fixture.uploads.length).toBe(2);
  s.sendButton().click();
  await expect.poll(() => s.bubble("Read the crew list aloud.") !== undefined).toBe(true);
  await acknowledged(fixture, s, "Read the crew list aloud.");
  await typed(s, "Ask Circe about the passage.");
  await expect.poll(() => fixture.rows.get(s.draft()!.draftId)?.text, { timeout: 5_000 }).toBe("Ask Circe about the passage.");
  const id = s.draft()!.draftId;
  expect(fixture.snapshotsOf(id).map((x) => [x.text, x.state])).toEqual([["Chart the strait.", "returned"], ["Read the crew list aloud.", "held"]]);
  for (const text of [fixture.rows.get(id)!.text, ...fixture.snapshotsOf(id).map((x) => x.text), s.field().value]) {
    expect(text.split("\n"), "no text is concatenated").toHaveLength(1);
  }
  // At 320px every action keeps its reach and never overlaps the indicator.
  for (const b of s.bubbles()) {
    const indicator = b.querySelector(".bk-status-indicator-btn")!.getBoundingClientRect();
    for (const button of b.querySelectorAll<HTMLElement>("[data-snapshot-actions] [data-bk-button]")) {
      expect(button.classList.contains("bk-hit")).toBe(true);
      const box = button.getBoundingClientRect();
      expect(box.bottom <= indicator.top || box.top >= indicator.bottom || box.right <= indicator.left || box.left >= indicator.right).toBe(true);
    }
  }
  // Edit is unavailable while the composer holds the newer draft.
  const edit = action(s.bubble("Chart the strait.")!, "Edit")!;
  expect(edit.getAttribute("aria-disabled")).toBe("true");
  expect(edit.textContent).toContain("Edit opens when the composer is empty.");
  edit.click();
  expect(s.field().value).toBe("Ask Circe about the passage.");
  expect(s.bubble("Chart the strait."), "nothing moved").toBeDefined();
  // Rev 4 case 6: the held one's file stores, and only it is sent; the newer text stays.
  release();
  await expect.poll(() => s.messages().length, { timeout: 5_000 }).toBe(1);
  const frame = s.messages()[0]!;
  expect(frame.text, "the snapshot's own text").toBe("Read the crew list aloud.");
  const held = fixture.snapshotsOf(id).find((x) => x.text === "Read the crew list aloud.")!;
  expect(frame.requestId).toBe(held.requestId);
  expect(frame.attachmentRefs).toEqual(held.fileIds.map((fileId) => ({ kind: "attachment", fileId })));
  expect(held.fileIds).toHaveLength(1);
  expect(fixture.files.get(held.fileIds[0]!)!.name).toBe("crew-list.txt");
  expect(frame.draftRef!.draftId).toBe(id);
  expect(s.field().value, "the newer text stays").toBe("Ask Circe about the passage.");
  // Accepted: the bubble becomes the sent message.
  fixture.accept(frame);
  s.socket.deliver({ type: "session_info", sessionId: SESSION, isNew: false, requestId: frame.requestId });
  await expect.poll(() => s.bubble("Read the crew list aloud.")).toBeUndefined();
  expect(s.root.stores.chat.getState().buffers[SESSION]!.messages.some((m) => m.role === "user" && m.content === "Read the crew list aloud.")).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(s.messages(), "sent once").toHaveLength(1);
  // An empty composer opens Edit: the snapshot moves in, caret at the end.
  await typed(s, "");
  const editNow = action(s.bubble("Chart the strait.")!, "Edit")!;
  await expect.poll(() => editNow.getAttribute("aria-disabled")).toBeNull();
  editNow.click();
  await expect.poll(() => s.field().value).toBe("Chart the strait.");
  await expect.poll(() => document.activeElement).toBe(s.field());
  expect(s.field().selectionStart).toBe("Chart the strait.".length);
  await expect.poll(() => fixture.snapshotsOf(id).length, { timeout: 5_000 }).toBe(0);
});

test("case 25: a background upload failure while typing keeps focus in the composer and is announced once", async () => {
  const fixture = snapshotHost();
  const s = await mount(fixture);
  const release = fixture.holdUploads();
  await typed(s, "Bring the crew list.");
  pickFiles(s, [crewList()]);
  await expect.poll(() => fixture.uploads.length).toBe(1);
  s.sendButton().click();
  await expect.poll(() => s.bubbles().length).toBe(1);
  await acknowledged(fixture, s, "Bring the crew list.");
  s.field().focus();
  await userEvent.type(s.field(), "Polites keeps watch");
  fixture.refuseNextUpload();
  release();
  await expect.poll(() => heading(s.bubbles()[0]!).textContent, { timeout: 5_000 }).toBe("Not sent");
  // Checked before any further typing, which would itself put focus back in the field.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(document.activeElement, "the failure moved no focus").toBe(s.field());
  expect(s.bubbles()[0]!.querySelector("[data-snapshot-why]")!.textContent).toBe("crew-list.txt: This host's attachment space is full. Nothing was removed to make room.");
  expect(indicatorName(s.bubbles()[0]!)).toBe("Message 1 of 1: Not sent. Details.");
  await userEvent.type(s.field(), ".");
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  expect(document.activeElement, "focus stays in the composer").toBe(s.field());
  expect(s.field().value).toBe("Polites keeps watch.");
  expect(s.spoken).toEqual(["1 message not sent: crew-list.txt wasn't stored."]);
  expect(s.host.querySelectorAll("[data-outgoing-snapshot] [data-status-live]"), "the indicator does not speak it a second time").toHaveLength(0);
  await expect.poll(() => fixture.snapshotsOf(s.draft()!.draftId)[0]?.state, { timeout: 5_000 }).toBe("returned");
  expect(s.messages()).toHaveLength(0);
});

test("case 26: a held snapshot restored after reload is Paused and sends nothing until Send", async () => {
  const fixture = snapshotHost();
  const first = await mount(fixture);
  fixture.holdUploads();
  await typed(first, "Signal Penelope from the headland.");
  pickFiles(first, [crewList()]);
  await expect.poll(() => fixture.uploads.length).toBe(1);
  first.sendButton().click();
  const id = first.draft()?.draftId ?? first.root.stores.drafts.getState().idFor(SESSION);
  await expect.poll(() => fixture.snapshotsOf(id)[0]?.state, { timeout: 5_000 }).toBe("held");
  first.reload();
  const s = await mount(fixture);
  await expect.poll(() => s.bubbles().length, { timeout: 5_000 }).toBe(1);
  const b = s.bubbles()[0]!;
  expect(heading(b).textContent).toBe("Paused after reload · files stored");
  expect(b.querySelector(".bk-status-indicator")!.getAttribute("data-status-indicator")).toBe("attention");
  expect(action(b, "Send")).toBeDefined();
  expect(action(b, "Cancel")).toBeDefined();
  // A save after the reload (typing) and a reconnect each run the client's
  // send step; neither sends a paused hold.
  await typed(s, "Keep the beacon lit.");
  await expect.poll(() => saved(s), { timeout: 5_000 }).toBe(true);
  s.root.stores.connection.setState({ wsStatus: "disconnected" });
  s.root.stores.connection.setState({ wsStatus: "connected" });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(s.messages(), "never sends by itself").toHaveLength(0);
  expect(s.field().value).toBe("Keep the beacon lit.");
  action(b, "Send")!.click();
  await expect.poll(() => s.messages().length, { timeout: 5_000 }).toBe(1);
  expect(s.messages()[0]!.text).toBe("Signal Penelope from the headland.");
  expect(s.messages()[0]!.requestId).toBe(fixture.snapshotsOf(id)[0]!.requestId);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(s.messages()).toHaveLength(1);
});

test("case 27: after a reload a dispatched snapshot is unconfirmed; Check reads once, and Send again is a new request only on its tap", async () => {
  const fixture = snapshotHost();
  const first = await mount(fixture);
  await typed(first, "Did the swineherd get word?");
  first.sendButton().click();
  await expect.poll(() => first.messages().length, { timeout: 5_000 }).toBe(1);
  const original = first.messages()[0]!;
  expect(first.bubbles(), "waiting on its answer, the transcript's row stands for it").toHaveLength(0);
  // The socket drops before an answer: the send is unconfirmed, said once, and focus stays.
  first.field().focus();
  first.root.stores.connection.setState({ wsStatus: "disconnected" });
  await expect.poll(() => first.bubbles().length).toBe(1);
  expect(heading(first.bubbles()[0]!).textContent).toBe("Couldn't confirm this was sent");
  expect(document.activeElement).toBe(first.field());
  await expect.poll(() => first.spoken).toEqual(["Couldn't confirm a message was sent."]);
  first.reload();
  const s = await mount(fixture);
  await expect.poll(() => s.bubbles().length, { timeout: 5_000 }).toBe(1);
  const b = s.bubbles()[0]!;
  expect(heading(b).textContent).toBe("Couldn't confirm this was sent");
  expect(indicatorName(b)).toBe("Message 1 of 1: Couldn't confirm this was sent. Details.");
  expect(action(b, "Delete…"), "not deletable").toBeUndefined();
  expect(s.host.querySelector("[data-unconfirmed-send]"), "the bubble replaces the review block").toBeNull();
  fixture.setRecovery({ revision: 3, latestRequestId: "another-request" });
  action(b, "Check")!.click();
  await expect.poll(() => b.textContent ?? "", { timeout: 5_000 }).toContain("Can't check · the host's latest is another message");
  expect(fixture.recoveryReads, "one recovery read").toEqual([SESSION]);
  expect(s.messages(), "Check sends nothing").toHaveLength(0);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(s.messages()).toHaveLength(0);
  action(b, "Send again")!.click();
  await expect.poll(() => s.messages().length, { timeout: 5_000 }).toBe(1);
  const again = s.messages()[0]!;
  expect(again.requestId).not.toBe(original.requestId);
  expect(again.text).toBe(original.text);
  const id = original.draftRef!.draftId;
  expect(fixture.snapshotsOf(id).map((x) => [x.requestId, x.state])).toEqual([[again.requestId, "dispatched"]]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(s.messages()).toHaveLength(1);
});

test("case 28: Delete… on a returned snapshot drops its references; the host keeps the file for its grace period and nothing is unlinked", async () => {
  const fixture = snapshotHost();
  const fileId = fixture.storeFile("draft-ithaca", "harbour-dues.txt");
  fixture.seed("draft-ithaca", [{ snapshotId: "ret", requestId: "r-ret", text: "Pay the harbour dues.", state: "returned", fileIds: [fileId] }]);
  expect(fixture.refs.get(fileId)).toEqual(new Set(["outgoing:draft-ithaca"]));
  const s = await mount(fixture);
  await expect.poll(() => s.bubbles().length, { timeout: 5_000 }).toBe(1);
  const b = s.bubbles()[0]!;
  expect(heading(b).textContent).toBe("Not sent");
  action(b, "Delete…")!.click();
  await expect.poll(() => document.querySelector("[data-snapshot-delete]")?.textContent ?? "").toContain(
    "Delete this unsent message and its 1 file? It stays on this brain for 7 days, then is removed.");
  action(document.querySelector("[data-snapshot-delete]")!, "Delete")!.click();
  await expect.poll(() => fixture.snapshotsOf("draft-ithaca").length, { timeout: 5_000 }).toBe(0);
  const removing = fixture.saves.filter((x) => x.status === 200).at(-1)!;
  expect(removing.body.snapshots, "the save leaves it out").toEqual([]);
  expect(fixture.refs.get(fileId)?.size ?? 0, "its references are gone").toBe(0);
  expect(fixture.unreferencedSince.has(fileId), "the grace clock starts").toBe(true);
  expect(fixture.unlinked.size, "nothing is unlinked").toBe(0);
  expect(fixture.files.has(fileId)).toBe(true);
  await expect.poll(() => document.activeElement).toBe(s.field());
  expect(s.spoken.at(-1)).toBe("Unsent message deleted.");
  expect(s.bubbles()).toHaveLength(0);
  // No bubble, no transcript node: the last message stays the column's last row (#1013).
  expect(s.host.querySelector("[data-transcript]")!.children, "nothing left in the transcript").toHaveLength(0);
});
