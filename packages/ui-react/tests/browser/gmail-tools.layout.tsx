/**
 * A Gmail thread tool result in a real browser (#4210):
 *
 * - the session's replayed history holds a Gmail read call under the Claude
 *   bridge spelling, and the transcript's own `MessageBubble` draws it from
 *   that stored entry: the Gmail renderer draws the kit's thread from the
 *   recorded payload, the subject heads it, the newest message is open and
 *   an earlier one opens on a real click;
 * - while it renders, nothing is requested from any origin but the page's:
 *   the earlier message's `<img>` stays text (a positive control proves the
 *   log sees requests);
 * - "Show the rest" loads only on its press, through one GET to #4207's
 *   display-only route, and draws exactly the part after what Brain read;
 * - loading it changes nothing the model's turn is built from: the stored
 *   call's output and the whole chat store are byte-identical before and
 *   after.
 *
 * The detail route is answered by the root's `request`, the one seam every
 * detail call goes through, so no network is involved.
 */
import { afterEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { visibleToolName } from "@schlessera/brain-ui-sdk/client";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { GMAIL_TOOL_NAMES } from "@schlessera/brain-ui-sdk/tool-contracts";
import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { registerBuiltinRenderers } from "../../src/components/chat/renderers/index.js";
import { BrainUiProvider, useRootStore } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { ChatMessage } from "../../src/stores/chat-store.js";
import { watchdogMs } from "../../../../scripts/test-deadlines.js";
import { RAFT, RAFT_FULL, RAFT_SHOWN, REST_MARK, SESSION, THREAD, raftBody, threadRead } from "../gmail-fixtures.js";

declare module "vitest/browser" {
  interface BrowserCommands {
    startRequestLog: () => Promise<void>;
    requestLog: (options?: { settle: boolean }) => Promise<string[]>;
  }
}

let host: HTMLDivElement | undefined;
let renderer: Root | undefined;
let root: BrainUiRoot | undefined;
const extras: HTMLElement[] = [];
afterEach(() => {
  if (renderer) flushSync(() => renderer!.unmount());
  root?.dispose();
  host?.remove();
  for (const el of extras.splice(0)) el.remove();
  renderer = undefined;
  root = undefined;
  host = undefined;
});

const calls: { url: string; method: string }[] = [];
const STORED = "gm-stored";
const RECORDED = JSON.stringify(threadRead("content"));
const NO_MESSAGES: ChatMessage[] = [];

/** The transcript as the chat draws it: each stored message through its own `MessageBubble`. */
function Transcript() {
  const messages = useRootStore("chat", (s) => s.buffers[SESSION]?.messages ?? NO_MESSAGES);
  return (
    <>
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} onToolApproval={() => {}} onAskUserSubmit={() => {}} onAskUserCancel={() => {}} onAskUserListSubmit={() => {}} />
      ))}
    </>
  );
}

/** The Gmail read call as the session's buffer stores it. */
const storedOutput = () => root!.stores.chat.getState().buffers[SESSION]?.messages.flatMap((m) => m.toolCalls).find((t) => t.id === STORED)?.output;

/**
 * A session whose replayed history (through the socket's own
 * `session_history` handler) holds the Gmail read call, drawn from that
 * stored entry and opened as a reader opens it.
 */
async function mountThread() {
  calls.length = 0;
  root = createBrainUiRoot({
    storage: null,
    request: async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      return String(url).endsWith(`/google/gmail/messages/${RAFT}/body`) ? Response.json(raftBody()) : Response.json({}, { status: 404 });
    },
  });
  root.stores.chat.getState().setActiveSession(SESSION);
  registerBuiltinRenderers(root.renderers);
  const name = visibleToolName(GMAIL_TOOL_NAMES.read, "claude");
  expect(root.renderers.resolve({ id: STORED, name, input: {}, isError: false }, "claude")?.label, "the bridge spelling resolves to the Gmail renderer").toBe("Gmail");
  root.connection.handleServerMessage({
    type: "session_history",
    sessionId: SESSION,
    messages: [
      { role: "user", content: "Read me Calypso's letter about the raft.", toolCalls: [] },
      { role: "assistant", content: "", toolCalls: [{ id: STORED, name, input: { target: "thread", id: THREAD, view: "content" }, output: RECORDED }], parts: [{ kind: "tool", toolIndex: 0 }] },
    ],
  } as unknown as ServerMessage);
  host = document.createElement("div");
  host.style.cssText = "width:760px;padding:16px;background:var(--bk-color-canvas);color:var(--bk-color-ink)";
  document.body.append(host);
  renderer = createRoot(host);
  flushSync(() => renderer!.render(<BrainUiProvider root={root!}><Transcript /></BrainUiProvider>));
  // History mounts collapsed: the run's summary row opens it, then the call's own row.
  await userEvent.click([...host.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "1 step")!);
  await userEvent.click(host.querySelector<HTMLElement>(`[data-tool-call='${STORED}'] button`)!);
  await expect.poll(() => host!.querySelector("[data-gmail-thread='content']"), { message: "the stored call draws its thread" }).not.toBeNull();
}

/** Requests the browser made, data URLs aside. */
const recorded = async () => (await commands.requestLog()).filter((url) => !url.startsWith("data:"));
const foreign = (urls: string[]) => urls.filter((url) => !url.startsWith(location.origin));
const detail = () => host!.querySelector("[data-gmail-detail]")?.getAttribute("data-gmail-detail");

test("a Gmail thread from its payload: drawn by the kit, nothing leaves the page's origin, and the rest loads only when asked and stays out of the chat store", async () => {
  await page.viewport(900, 900);
  await commands.startRequestLog();
  // Positive control: the log records an image this test adds itself. Polled
  // without waiting for network idle: the request need only be issued. The
  // timeout is a watchdog, far above the request's start.
  const control = document.createElement("img");
  control.src = `${location.origin}/gmail-tools-positive-control.png?${crypto.randomUUID()}`;
  document.body.append(control);
  extras.push(control);
  await expect.poll(recorded, { timeout: watchdogMs(15_000), message: "the log records a same-origin image" }).toContain(control.src);

  await mountThread();
  expect(storedOutput(), "the card is drawn from the stored call").toBe(RECORDED);
  const history = JSON.stringify(root!.stores.chat.getState());
  const thread = host!.querySelector<HTMLElement>("[data-gmail-thread='content']")!;
  expect(thread.querySelector("h3")?.textContent).toBe("The raft");
  expect([...thread.querySelectorAll("[data-gmail-thread-message]")].map((m) => m.getAttribute("data-gmail-thread-message"))).toEqual(["closed", "closed", "open"]);
  expect(thread.getBoundingClientRect().width, "the card fills its column").toBeGreaterThan(600);

  // An earlier message opens on a real click; its <img> is the sender's text, not an image.
  const earlier = [...thread.querySelectorAll<HTMLButtonElement>("button[aria-expanded='false']")].find((b) => b.getAttribute("aria-label")?.startsWith("Calypso, "))!;
  await userEvent.click(earlier);
  await expect.poll(() => thread.textContent).toContain("The bronze axe is by the cave mouth.");
  expect(thread.querySelectorAll("img"), "no image in the thread").toHaveLength(0);
  expect(thread.textContent).toContain('<img src="https://tracker.example/pixel.gif"');

  // The rest: nothing until the press, then one GET to the display-only route.
  expect(detail()).toBe("idle");
  expect(calls, "no detail request before the reader acts").toEqual([]);
  // The kit's Button is a `role="button"`.
  const show = [...thread.querySelectorAll<HTMLElement>("[role='button']")].find((b) => b.textContent?.startsWith("Show the rest"))!;
  expect(show.textContent).toBe(`Show the rest · ${(RAFT_FULL.length - RAFT_SHOWN.length).toLocaleString("en-US")} characters`);
  await userEvent.click(show);
  await expect.poll(() => calls.length, { message: "the press asked once" }).toBe(1);
  await expect.poll(() => host!.querySelector("[data-gmail-detail]")?.getAttribute("data-gmail-detail") !== "loading", { message: "the request has answered" }).toBe(true);

  // Display-only: the route proves the session's history unchanged
  // (GMAIL_DETAIL_HISTORY_UNCHANGED, packages/ui-server/tests/ws-google-details.test.ts);
  // here, the stored call and the client's chat state, the turn's source on
  // this side, are byte-identical.
  expect(storedOutput(), "the stored call's output is unchanged").toBe(RECORDED);
  const after = JSON.stringify(root!.stores.chat.getState());
  expect(after.includes(REST_MARK), "the rest is in no store").toBe(false);
  expect(after, "loading the rest changes nothing the model's turn is built from").toBe(history);

  expect(detail()).toBe("loaded");
  const rest = thread.querySelector("[data-gmail-rest]")?.textContent ?? "";
  expect(rest.endsWith(REST_MARK), "the rest ends where the letter does").toBe(true);
  expect(rest.length, "exactly the part after what Brain read").toBe(RAFT_FULL.length - RAFT_SHOWN.length);
  expect(calls).toEqual([{ url: `/api/sessions/${SESSION}/google/gmail/messages/${RAFT}/body`, method: "GET" }]);

  const log = await recorded();
  expect(log, "positive control: the log still holds the control").toContain(control.src);
  expect(foreign(log), "no request left the page's origin").toEqual([]);
});
