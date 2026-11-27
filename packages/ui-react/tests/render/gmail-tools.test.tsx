// The host Gmail read tools' results as the ui-kit Gmail components (#4210):
// the bare and bridge spellings on both backends (and the legacy one left to
// the generic renderer), both views of search, thread and message read from
// recorded payloads, the safe fallback for drafts, the label list and cut or
// broken output, the tool row's effect class and view, and the rest of a cut
// body from the display-only detail route: what it asks, how its answers and
// errors read, the prefix check, its stale-answer, unmount and cancel guards,
// and that the loaded text never reaches the session's stored transcript.
// Keyless, mounted in happy-dom.
import { registerGmailToolsDom, unregisterGmailToolsDom } from "./gmail-tools-dom.js";

registerGmailToolsDom();

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render as mount, type RenderResult } from "@testing-library/react";
import { MotionConfig } from "framer-motion";
import type { ReactElement, ReactNode } from "react";
import { visibleToolName, type ToolCallView } from "@schlessera/brain-ui-sdk/client";
import { revealInvisibles } from "@schlessera/brain-ui-kit";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { GMAIL_TOOL_NAMES } from "@schlessera/brain-ui-sdk/tool-contracts";
import { resetToolRenderers, resolveToolRenderer } from "../../../ui-sdk/src/client/renderers.js";
import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { GENERIC_RENDERER, registerBuiltinRenderers } from "../../src/components/chat/renderers/index.js";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { createBodyLoader, type BodyDetail } from "../../src/components/chat/tool-cards/gmail-cards.js";
import type { GmailBodyResult } from "../../src/lib/gmail-details.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider, useRootStore } from "../../src/root-context.js";
import type { ChatMessage, ToolCall } from "../../src/stores/chat-store.js";
import {
  HIDDEN_ON_A_THREAD, HIDDEN_SUBJECT, HOSTILE_LINE, RAFT, RAFT_FULL, RAFT_SHOWN, REST_MARK, SENDER_PATH, SESSION, THREAD,
  cutOutput, draftRead, hostileMessageRead, labelsRead, messageRead, raftBody, raftMessages, refusal, searchPage, threadRead,
} from "../gmail-fixtures.js";

const roots: ReturnType<typeof createBrainUiRoot>[] = [];
const requested: { url: string; method: string }[] = [];
/** The signal each request carried, in order. */
const signals: (AbortSignal | undefined)[] = [];
/** What the next detail-route call answers; the default is a 404 with no body. */
let answer: (url: string) => Response | Promise<Response> = () => new Response("{}", { status: 404 });
afterEach(async () => {
  await act(async () => {
    cleanup();
    for (const root of roots.splice(0)) root.dispose();
  });
  requested.length = 0;
  signals.length = 0;
  answer = () => new Response("{}", { status: 404 });
});
afterAll(async () => {
  await act(async () => cleanup());
  resetToolRenderers();
  await unregisterGmailToolsDom();
});

function makeRoot(): BrainUiRoot {
  const root = createBrainUiRoot({
    storage: null,
    request: async (url, init) => {
      requested.push({ url: String(url), method: init?.method ?? "GET" });
      signals.push(init?.signal ?? undefined);
      return answer(String(url));
    },
  });
  roots.push(root);
  return root;
}

/**
 * The root's provider, with animations skipped: a row that opens animates its
 * height, and happy-dom rejects a cancelled animation's `finished` promise,
 * which unmounting mid-animation would leave unhandled.
 */
const Provided = ({ root, children }: { root: BrainUiRoot; children: ReactNode }) => (
  <BrainUiProvider root={root}><MotionConfig skipAnimations>{children}</MotionConfig></BrainUiProvider>
);

function render(ui: ReactElement, session: string | null = SESSION) {
  const root = makeRoot();
  // A session, so the rest of a body is possible: a test that sees no request
  // has proved the card did not ask, not that it could not.
  if (session) root.stores.chat.setState({ activeSessionId: session });
  return { view: mount(<Provided root={root}>{ui}</Provided>), root };
}

type Tool = "search" | "read";
/** The names a Gmail call arrives under: the Claude bridge name and Pi's bare one. */
const spellings = (tool: Tool) =>
  [
    [visibleToolName(GMAIL_TOOL_NAMES[tool], "claude"), "claude"],
    [visibleToolName(GMAIL_TOOL_NAMES[tool], "pi"), "pi"],
  ] as const;
/** The pre-rename prefix: older than the Gmail tools, and refused by the detail route. */
const legacy = (tool: Tool) => `mcp__brain_ui__${GMAIL_TOOL_NAMES[tool]}`;

const SEARCH_INPUT = { query: "from:calypso raft", view: "content" };

function call(name: string, output: unknown, over: Partial<ToolCallView> = {}): ToolCallView {
  return { id: "gm1", name, input: {}, ...(output === undefined ? {} : { output: typeof output === "string" ? output : JSON.stringify(output) }), isError: false, ...over };
}

function renderer(tool: Tool, backend: "claude" | "pi" = "pi") {
  registerBuiltinRenderers();
  const name = visibleToolName(GMAIL_TOOL_NAMES[tool], backend);
  return { name, renderer: resolveToolRenderer(call(name, undefined), backend)! };
}

function output(tool: Tool, result: unknown, options: { backend?: "claude" | "pi"; input?: Record<string, unknown>; session?: string | null } = {}) {
  const { name, renderer: r } = renderer(tool, options.backend);
  const Output = r.Output!;
  return render(<Output tool={call(name, result, { input: options.input ?? {} })} />, options.session === undefined ? SESSION : options.session);
}

const text = (view: RenderResult) => view.container.textContent ?? "";
/**
 * An element as its markup, so a failing assertion prints a string: asked to
 * diff a happy-dom element, the matcher walks the whole DOM graph and runs
 * out of memory instead of failing.
 */
const html = (el: Element | null | undefined) => el?.outerHTML ?? null;
const detailState = (view: RenderResult) => [...view.container.querySelectorAll("[data-gmail-detail]")].map((n) => n.getAttribute("data-gmail-detail"));
const detailCalls = () => requested.filter((r) => r.url.includes("/google/"));

/** A promise the test settles itself: a request still in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

/** Press, then wait for the section to leave `loading`: the answer has arrived and been drawn. */
async function press(view: RenderResult, target: HTMLElement) {
  await act(async () => fireEvent.click(target));
  for (let turn = 0; turn < 20 && detailState(view).includes("loading"); turn++) await act(async () => {});
  expect(detailState(view), "the request has answered").not.toContain("loading");
}
const showTheRest = (view: RenderResult) => view.getByRole("button", { name: /^Show the rest/ });

// ---------------------------------------------------------------------------
// The session's stored transcript, as the host replays it
// ---------------------------------------------------------------------------

const STORED = "gm-stored";
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

/**
 * A session whose replayed history holds one Gmail read call with `output`,
 * through the socket's own `session_history` handler, drawn from that stored
 * entry and opened as a reader opens it: the run's summary row, then the call.
 */
function transcript(output: string, call: { name: string; input: Record<string, unknown> } = { name: visibleToolName(GMAIL_TOOL_NAMES.read, "claude"), input: { target: "thread", id: THREAD, view: "content" } }) {
  const root = makeRoot();
  root.stores.chat.getState().setActiveSession(SESSION);
  root.connection.handleServerMessage({
    type: "session_history",
    sessionId: SESSION,
    messages: [
      { role: "user", content: "Read me Calypso's letter about the raft.", toolCalls: [] },
      {
        role: "assistant", content: "",
        toolCalls: [{ id: STORED, name: call.name, input: call.input, output }],
        parts: [{ kind: "tool", toolIndex: 0 }],
      },
    ],
  } as unknown as ServerMessage);
  const view = mount(<Provided root={root}><Transcript /></Provided>);
  const entry = () => view.container.querySelector<HTMLElement>(`[data-tool-call='${STORED}']`);
  // History mounts collapsed: the run's summary row opens it, then the call's own row.
  fireEvent.click(view.getByRole("button", { name: "1 step" }));
  fireEvent.click(entry()!.querySelector("button")!);
  return { view, root };
}

/** The Gmail read call as the session's buffer stores it. */
const storedCall = (root: BrainUiRoot) => root.stores.chat.getState().buffers[SESSION]?.messages.flatMap((m) => m.toolCalls).find((t) => t.id === STORED);

describe("binding", () => {
  test("search and read resolve under the bridge and bare spellings, on both backends, to their Gmail renderers", () => {
    registerBuiltinRenderers();
    const labels: Record<Tool, string> = { search: "Gmail search", read: "Gmail" };
    for (const tool of ["search", "read"] as const) {
      for (const [name, backend] of spellings(tool)) {
        for (const on of ["claude", "pi"] as const) {
          expect(resolveToolRenderer(call(name, undefined), on)?.label, `${name} (${backend}'s spelling) on ${on}`).toBe(labels[tool]);
        }
      }
    }
  });

  test("the legacy mcp__brain_ui__ spelling resolves to the generic renderer, not Gmail's", () => {
    registerBuiltinRenderers();
    for (const tool of ["search", "read"] as const) {
      for (const backend of ["claude", "pi"] as const) {
        const resolved = resolveToolRenderer(call(legacy(tool), undefined), backend) ?? GENERIC_RENDERER;
        expect(resolved, `${legacy(tool)} on ${backend}: GMAIL_LEGACY_SPELLING_GENERIC`).toBe(GENERIC_RENDERER);
      }
    }
    // In the transcript: the generic row and output, and no Gmail card or rest on offer.
    const tools: ToolCall[] = [{ id: "l1", name: legacy("read"), input: {}, inputJson: "{}", output: JSON.stringify(messageRead("content")), status: "complete", isError: false }];
    const { view } = render(<ToolCallTimeline live toolCalls={tools} onApproval={() => {}} />);
    const row = view.container.querySelector("[data-tool-call='l1'] button")!;
    expect(row.textContent).not.toContain("read · ");
    fireEvent.click(row);
    expect(html(view.container.querySelector("[data-gmail-message], [data-gmail-detail]"))).toBeNull();
  });

  test("each result renders its kit component on both backends", () => {
    for (const backend of ["claude", "pi"] as const) {
      expect(output("search", searchPage("content"), { backend }).view.container.querySelector("[data-gmail-results='content']"), `search on ${backend}`).not.toBeNull();
      expect(output("read", threadRead("content"), { backend }).view.container.querySelector("[data-gmail-thread='content']"), `thread on ${backend}`).not.toBeNull();
      expect(output("read", messageRead("content"), { backend }).view.container.querySelector("[data-gmail-message='content']"), `message on ${backend}`).not.toBeNull();
    }
  });

  test("output that is not a result envelope falls back to its own words", () => {
    const { view } = output("read", "Gmail tool host failed: socket closed");
    expect(view.container.querySelector("[data-gmail-thread], [data-gmail-message]")).toBeNull();
    expect(text(view)).toContain("socket closed");
  });

  test("a refusal is drawn in its own words, not as a component", () => {
    const { view } = output("search", refusal("search", "unavailable", "not_connected", "Gmail is not connected on this host."));
    expect(text(view)).toBe("Gmail is not connected on this host.");
    expect(view.container.querySelector("[data-gmail-results]")).toBeNull();
  });
});

describe("search, both views", () => {
  test("structured: one row per thread with its day and count, the G1 line, and nothing a sender wrote", () => {
    const { view } = output("search", searchPage("structured"), { input: { ...SEARCH_INPUT, view: "structured" } });
    const rows = [...view.container.querySelectorAll("[data-gmail-row='structured']")];
    expect(rows.map((row) => row.querySelector("time")?.getAttribute("dateTime"))).toEqual(["2026-07-11T16:02:00Z", "2026-07-09T19:40:00Z", "2026-07-08T05:15:00Z"]);
    expect(rows[0]!.textContent).toContain("3 messages");
    expect(view.container.querySelector("[data-gmail-view-line]")?.textContent).toBe("Structured view · dates, labels and counts only. Brain didn't read these messages.");
    for (const word of ["Calypso", "Penelope", "Antinous", "raft.", "loom"]) expect(text(view), word).not.toContain(word);
  });

  test("content: senders and subjects as written, the query from the call's input, and Gmail's next page", () => {
    const { view } = output("search", searchPage("content"), { input: SEARCH_INPUT });
    const rows = [...view.container.querySelectorAll("[data-gmail-row='content']")];
    expect(rows.map((row) => row.querySelector("[data-untrusted-field]")?.textContent)).toEqual(["Calypso", "Penelope", "Antinous"]);
    expect(text(view)).toContain("“from:calypso raft” · newest first");
    expect(view.container.querySelector("[data-gmail-footnote]")?.textContent).toBe("Gmail has more matches. Ask Brain for the next page.");
    // The kit reveals a hidden character in what a sender wrote; the mapping passes it on as written.
    expect(HIDDEN_SUBJECT, "the fixture carries the override").toContain("\u{202E}");
    expect(rows[2]!.querySelector("[data-hidden-char]")?.getAttribute("data-hidden-char")).toBe("‹U+202E›");
  });

  test("a last page says nothing about more", () => {
    const { view } = output("search", searchPage("content", null), { input: SEARCH_INPUT });
    expect(view.container.querySelectorAll("[data-gmail-row='content']").length).toBe(3);
    expect(view.container.querySelector("[data-gmail-footnote]")).toBeNull();
  });
});

describe("thread, both views", () => {
  test("structured: 'Thread · 3 messages' under the G1 line, each message's time, and nothing a sender wrote", () => {
    const { view } = output("read", threadRead("structured"));
    expect(view.container.querySelector("[data-gmail-thread='structured'] h3")?.textContent).toBe("Thread · 3 messages");
    expect([...view.container.querySelectorAll("[data-gmail-row='structured'] time")].map((t) => t.getAttribute("dateTime"))).toEqual(["2026-07-05T07:30:00Z", "2026-07-06T18:15:00Z", "2026-07-11T16:02:00Z"]);
    for (const word of ["Calypso", "Hermes", "Zeus", "Log 1"]) expect(text(view), word).not.toContain(word);
    expect(text(view), "no rest to load in a view that shows no body").not.toContain("Show the rest");
  });

  test("content: the subject heads it, the newest message is open with what Brain read, and a body's markup stays text", () => {
    const { view } = output("read", threadRead("content"));
    const thread = view.container.querySelector("[data-gmail-thread='content']")!;
    expect(thread.querySelector("h3")?.textContent).toBe("The raft");
    expect([...thread.querySelectorAll("[data-gmail-thread-message]")].map((m) => m.getAttribute("data-gmail-thread-message"))).toEqual(["closed", "closed", "open"]);
    expect(thread.querySelector("[data-brain-read]")?.textContent).toBe("Brain read the first 32,768 of 39,077 characters.");
    expect(RAFT_FULL.length, "the fixture's total").toBe(39_077);
    expect(showTheRest(view).textContent).toBe("Show the rest · 6,309 characters");
    fireEvent.click(view.getByRole("button", { name: /^Calypso, / , expanded: false }));
    expect(text(view)).toContain("The bronze axe is by the cave mouth.");
    expect(view.container.querySelector("img"), "the sender's <img> is text, not an image").toBeNull();
    expect(text(view)).toContain('<img src="https://tracker.example/pixel.gif"');
  });
});

describe("message, both views", () => {
  test("structured: one message under the G1 line, with its flags and no sender's words", () => {
    const { view } = output("read", messageRead("structured"));
    expect(view.container.querySelector("[data-gmail-message='structured'] h3")?.textContent).toBe("1 message");
    expect(view.container.querySelector("time")?.getAttribute("dateTime")).toBe("2026-07-11T16:02:00Z");
    expect(view.container.querySelector("[data-gmail-flags]")?.textContent).toContain("starred");
    for (const word of ["Calypso", "Re: The raft", "Log 1"]) expect(text(view), word).not.toContain(word);
  });

  test("content: the email from its sender, with the rest on offer", () => {
    const { view } = output("read", messageRead("content"));
    expect(view.container.querySelector("[data-gmail-message='content']")?.getAttribute("aria-label")).toBe("Email from Calypso");
    expect(view.container.querySelector("[data-brain-read]")?.textContent).toBe("Brain read the first 32,768 of 39,077 characters.");
    expect(detailState(view)).toEqual(["idle"]);
  });
});

/** Every link, button or other control whose words include `words`, as markup. */
const controlsWith = (view: RenderResult, words: string) =>
  [...view.container.querySelectorAll("a, button, [role='button'], [role='link'], [href]")].filter((el) => el.textContent?.includes(words)).map(html);

describe("the safe fallback: drafts, the label list, cut and broken output", () => {
  test("a draft has no kit component yet, so it keeps the tool's own output", () => {
    const result = draftRead();
    const { view } = output("read", result);
    expect(view.container.querySelector("[data-gmail-message], [data-gmail-thread]")).toBeNull();
    expect(text(view)).toBe(JSON.stringify(result));
  });

  test("a draft's hidden character shows as its marker, never as the override itself", () => {
    const { view } = output("read", draftRead(HOSTILE_LINE));
    expect(HOSTILE_LINE, "the fixture carries the override").toContain("\u{202E}");
    expect(text(view), "GMAIL_FALLBACK_REVEALS").toContain("see the list‹U+202E›fdp.exe");
    expect(text(view)).not.toContain("\u{202E}");
  });

  test("a path a draft's body names is text, not a link or a button into the brain", () => {
    const { view } = output("read", draftRead(HOSTILE_LINE));
    expect(text(view), "the path is on screen").toContain(SENDER_PATH);
    expect(controlsWith(view, SENDER_PATH), "GMAIL_FALLBACK_NO_LINKS").toEqual([]);
    expect(html(view.container.querySelector("a, .brain-file-link")), "no link at all").toBeNull();
  });

  test("the account's label list keeps every entry, system labels a thread hides included, with its counts", () => {
    const { name, renderer: r } = renderer("read");
    const result = labelsRead(HIDDEN_ON_A_THREAD);
    expect(r.summary?.(call(name, result)), "the row counts what the list holds").toBe("2 labels");
    const { view } = output("read", result);
    expect(html(view.container.querySelector("[data-gmail-label]")), "no thread chip row").toBeNull();
    expect(view.container.querySelector("pre")?.textContent, "GMAIL_LABELS_FALLBACK_EXACT").toBe(JSON.stringify(result));
  });

  test("a read output the history transport cut renders through the safe fallback", () => {
    const cut = cutOutput(JSON.stringify(hostileMessageRead()));
    expect(() => JSON.parse(cut), "the cut output is no longer JSON").toThrow();
    const { view } = output("read", cut);
    expect(html(view.container.querySelector("[data-gmail-message], [data-gmail-detail]"))).toBeNull();
    expect(text(view)).toContain("chars elided]");
    expect(text(view), "GMAIL_CUT_FALLBACK_REVEALS").toContain("see the list‹U+202E›fdp.exe");
    expect(text(view)).not.toContain("\u{202E}");
    expect(controlsWith(view, SENDER_PATH), "GMAIL_CUT_FALLBACK_NO_LINKS").toEqual([]);
  });
});

describe("the transcript's Copy output", () => {
  /** Press the stored call's Copy output and return what reached the clipboard. */
  async function copied(view: RenderResult): Promise<string[]> {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { written.push(text); } } });
    try {
      await act(async () => fireEvent.click(view.getByRole("button", { name: "Copy output" })));
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
    return written;
  }

  const SEARCH_CALL = { name: visibleToolName(GMAIL_TOOL_NAMES.search, "claude"), input: SEARCH_INPUT };
  const kinds: { kind: string; output: string; call?: { name: string; input: Record<string, unknown> }; marker: string }[] = [
    { kind: "a search card", output: JSON.stringify(searchPage("content")), call: SEARCH_CALL, marker: "Gifts for the queen‹U+202E›txt.exe" },
    { kind: "a message card", output: JSON.stringify(hostileMessageRead()), marker: "see the list‹U+202E›fdp.exe" },
    { kind: "the draft fallback", output: JSON.stringify(draftRead(HOSTILE_LINE)), marker: "see the list‹U+202E›fdp.exe" },
    { kind: "a cut output", output: cutOutput(JSON.stringify(hostileMessageRead())), marker: "see the list‹U+202E›fdp.exe" },
  ];
  for (const { kind, output, call, marker } of kinds) {
    test(`${kind} copies what the reader was shown: the marker, never the override`, async () => {
      expect(output, "the stored output carries the override").toContain("\u{202E}");
      const { view, root } = transcript(output, call);
      expect(text(view)).not.toContain("\u{202E}");
      const clip = await copied(view);
      expect(clip.length).toBe(1);
      expect(clip[0], "GMAIL_COPY_REVEALS").not.toContain("\u{202E}");
      expect(clip[0]).toContain(marker);
      expect(clip[0], "the whole output, not the clamped excerpt").toBe(revealInvisibles(output));
      expect(storedCall(root)?.output, "the stored output is untouched").toBe(output);
    });
  }

  test("a tool with no copyText still copies its output as stored", async () => {
    const raw = `exported list\u{202E}fdp.exe`;
    const { view } = transcript(raw, { name: "mcp__odysseus__ledger", input: {} });
    expect(await copied(view), "COPY_DEFAULT_RAW").toEqual([raw]);
  });
});

describe("the tool row: effect class and view", () => {
  for (const [label, tool, result, meta] of [
    ["a structured search", "search", searchPage("structured"), "read · structured view"],
    ["a content search", "search", searchPage("content"), "read · content view"],
    ["a structured thread", "read", threadRead("structured"), "read · structured view"],
    ["a content message", "read", messageRead("content"), "read · content view"],
    ["the label list", "read", labelsRead(), "read · structured view"],
    ["a refusal", "read", refusal("read", "policy_denied", null, "The policy does not allow reading Gmail."), "read · no result"],
    ["a refusal of a rate-limited search", "search", refusal("search", "rate_limited", null, "Gmail's request limit is used up."), "read · no result"],
    ["a call refused as invalid input, never classified", "read", refusal("read", "invalid_input", "id", "That is not a Gmail thread id."), "no result"],
    ["output that is not a result", "read", "Gmail tool host failed: socket closed", "read"],
    ["a call still running", "search", undefined, "read"],
  ] as const) {
    test(`${label} reads "${meta}"`, () => {
      const { name, renderer: r } = renderer(tool);
      expect(r.meta?.(call(name, result, { input: SEARCH_INPUT }))).toBe(meta);
    });
  }

  test("the row in the transcript shows the tool, what it read and its class and view", () => {
    registerBuiltinRenderers();
    const tools: ToolCall[] = [
      { id: "s1", name: visibleToolName(GMAIL_TOOL_NAMES.search, "claude"), input: SEARCH_INPUT, inputJson: JSON.stringify(SEARCH_INPUT), output: JSON.stringify(searchPage("content")), status: "complete", isError: false },
      { id: "r1", name: visibleToolName(GMAIL_TOOL_NAMES.read, "claude"), input: { target: "thread", id: "19a1c0de0f2b4a01", view: "structured" }, inputJson: "{}", output: JSON.stringify(threadRead("structured")), status: "complete", isError: false },
    ];
    const { view } = render(<ToolCallTimeline live toolCalls={tools} onApproval={() => {}} />);
    const rows = [...view.container.querySelectorAll("[data-tool-call]")].map((row) => row.querySelector("button")?.textContent);
    expect(rows).toEqual(["Gmail search“from:calypso raft”read · content view", "Gmailthread · 3 messagesread · structured view"]);
  });

  test("a query's hidden character shows as its marker in the row's summary", () => {
    const { name, renderer: r } = renderer("search");
    expect(r.summary?.(call(name, searchPage("content"), { input: { query: "subject:gifts\u{202E}exe" } }))).toBe("“subject:gifts‹U+202E›exe”");
  });
});

describe("the rest of a cut body", () => {
  test("rendering asks for nothing; the press asks the display route once, and the rest shows after what Brain read", async () => {
    answer = () => Response.json(raftBody());
    const { view } = output("read", messageRead("content"));
    expect(detailCalls(), "no detail request before the reader acts").toEqual([]);
    await press(view, showTheRest(view));
    expect(detailCalls()).toEqual([{ url: `/api/sessions/${SESSION}/google/gmail/messages/${RAFT}/body`, method: "GET" }]);
    expect(detailState(view)).toEqual(["loaded"]);
    const rest = view.container.querySelector("[data-gmail-rest]")?.textContent ?? "";
    expect(rest.endsWith(REST_MARK), "the rest ends where the letter does").toBe(true);
    expect(rest.length, "only the part after what Brain read").toBe(RAFT_FULL.length - RAFT_SHOWN.length);
  });

  test("the loaded rest never enters the session's transcript: the stored call and the whole chat state stay byte-identical", async () => {
    answer = () => Response.json(raftBody());
    const recorded = JSON.stringify(threadRead("content"));
    const { view, root } = transcript(recorded);
    expect(storedCall(root)?.output, "the card is drawn from the stored call").toBe(recorded);
    expect(view.container.querySelector("[data-gmail-thread='content']"), "the stored call draws its thread").not.toBeNull();
    const before = JSON.stringify(root.stores.chat.getState());
    const brainRead = view.container.querySelector("[data-brain-read]")?.textContent;
    await press(view, showTheRest(view));
    expect(storedCall(root)?.output, "GMAIL_REST_STORED_OUTPUT_UNCHANGED").toBe(recorded);
    const after = JSON.stringify(root.stores.chat.getState());
    expect(after.includes(REST_MARK), "GMAIL_REST_NEVER_IN_TRANSCRIPT").toBe(false);
    expect(after, "GMAIL_REST_DISPLAY_ONLY").toBe(before);
    expect(detailState(view)).toEqual(["loaded"]);
    expect(text(view), "the rest is on screen").toContain(REST_MARK);
    expect(view.container.querySelector("[data-brain-read]")?.textContent).toBe(brainRead);
  });

  test("with no chat to scope it to, a cut body offers no rest and asks for nothing", () => {
    const { view } = output("read", messageRead("content"), { session: null });
    expect(view.container.querySelector("[data-brain-read]")?.textContent).toBe("Brain read the first 32,768 of 39,077 characters.");
    expect(detailState(view)).toEqual([]);
    expect(detailCalls()).toEqual([]);
  });

  for (const [label, body] of [
    ["a full body that no longer begins with what Brain read", raftBody({ body_text: `x${RAFT_FULL.slice(1)}` })],
    ["a full body shorter than what Brain read", raftBody({ body_text: RAFT_SHOWN.slice(0, 1_000), body_length: 1_000 })],
    ["a full body the same as what Brain read", raftBody({ body_text: RAFT_SHOWN, body_length: RAFT_SHOWN.length })],
    ["no text body at all", raftBody({ body_text: null, body_length: null })],
  ] as const) {
    test(`${label} reads as unavailable, and nothing is spliced`, async () => {
      answer = () => Response.json(body);
      const { view } = output("read", messageRead("content"));
      await press(view, showTheRest(view));
      expect(detailState(view)).toEqual(["unavailable"]);
      expect(view.container.querySelector("[data-gmail-rest]")).toBeNull();
      expect(text(view)).toContain("The rest of this message can't load: Gmail isn't available to this brain right now.");
    });
  }

  test("the display route's own cut says so under the rest", async () => {
    answer = () => Response.json(raftBody({ body_truncated: true }));
    const { view } = output("read", messageRead("content"));
    await press(view, showTheRest(view));
    expect(detailState(view)).toEqual(["loaded"]);
    expect(text(view)).toContain("Cut at this view's limit of 1,048,576 characters.");
  });

  // Gap 7 of #4616: each route code reads as the kit's state for it.
  for (const [status, code, reason, state, words] of [
    [404, "not_found", null, "gone", "Gmail no longer shows this message to this brain"],
    [404, "not_found", "not_in_session", "gone", "Gmail no longer shows this message to this brain"],
    [503, "unavailable", "not_connected", "unavailable", "Gmail isn't available to this brain right now"],
    [503, "transport_incompatible", "binary_refused", "unavailable", "Gmail isn't available to this brain right now"],
    [403, "policy_denied", "disabled", "unavailable", "Gmail isn't available to this brain right now"],
    [429, "rate_limited", null, "rate-limited", "Gmail's request limit is used up."],
    [403, "forbidden", "not_owner", "error", "Couldn't load the rest of this message."],
    [502, "upstream_error", null, "error", "Couldn't load the rest of this message."],
    [400, "invalid_input", "message", "error", "Couldn't load the rest of this message."],
  ] as const) {
    test(`a ${status} ${code}/${reason} reads as ${state}`, async () => {
      answer = () => Response.json({ error: { code, reason, message: "The host's words." } }, { status });
      const { view } = output("read", messageRead("content"));
      await press(view, showTheRest(view));
      expect(detailState(view)).toEqual([state]);
      expect(text(view)).toContain(words);
      expect(text(view)).not.toContain(REST_MARK);
    });
  }

  for (const [label, reply] of [
    ["an unreadable 504 from a proxy", () => new Response("<html>", { status: 504 })],
    ["a 200 that is not this message's body", () => Response.json(raftBody({ message_id: "19a1c0de0f2b4a01" }))],
  ] as const) {
    test(`${label} reads as error, and Try again asks again`, async () => {
      answer = reply;
      const { view } = output("read", messageRead("content"));
      await press(view, showTheRest(view));
      expect(detailState(view)).toEqual(["error"]);
      answer = () => Response.json(raftBody());
      await press(view, view.getByRole("button", { name: "Try again" }));
      expect(detailState(view)).toEqual(["loaded"]);
      expect(detailCalls().length).toBe(2);
    });
  }

  test("unmounting the card cancels the request in flight", async () => {
    const late = deferred<Response>();
    answer = () => late.promise;
    const { view } = output("read", messageRead("content"));
    await act(async () => fireEvent.click(showTheRest(view)));
    expect(detailState(view)).toEqual(["loading"]);
    expect(signals.length, "one request is in flight").toBe(1);
    expect(signals[0]?.aborted, "not cancelled while the card is there").toBe(false);
    await act(async () => view.unmount());
    expect(signals[0]?.aborted, "GMAIL_REST_UNMOUNT_CANCELS").toBe(true);
    late.resolve(Response.json(raftBody()));
  });

  test("two presses before the card redraws ask twice, and only the newer answer shows", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const replies = [first, second];
    answer = () => replies.shift()!.promise;
    const { view } = output("read", messageRead("content"));
    const button = showTheRest(view);
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(detailCalls().length, "both presses asked").toBe(2);
    await act(async () => second.resolve(Response.json(raftBody())));
    expect(detailState(view)).toEqual(["loaded"]);
    await act(async () => first.resolve(Response.json({ error: { code: "upstream_error", reason: null, message: "Late." } }, { status: 502 })));
    expect(detailState(view), "GMAIL_REST_STALE_ANSWER_DROPPED").toEqual(["loaded"]);
    expect(text(view)).toContain(REST_MARK);
  });

  test("a search hit has no body, so a content search offers no rest", () => {
    const { view } = output("search", searchPage("content"), { input: SEARCH_INPUT });
    expect(view.container.querySelectorAll("[data-gmail-row='content']").length).toBe(3);
    expect(detailState(view)).toEqual([]);
  });
});

describe("the rest's requests (createBodyLoader)", () => {
  const cut = raftMessages[2]!;
  const states = (published: [string, BodyDetail][]) => published.map(([id, d]) => `${id}:${d.state}`);
  const loaded: GmailBodyResult = { ok: true, body: raftBody() };
  const failed: GmailBodyResult = { ok: false, error: { code: "upstream_error", reason: null, message: "Late." } };

  test("a stale answer that arrives after a newer request's does not overwrite it", async () => {
    const published: [string, BodyDetail][] = [];
    const loader = createBodyLoader((id, detail) => published.push([id, detail]));
    const older = deferred<GmailBodyResult>();
    const newer = deferred<GmailBodyResult>();
    const a = loader.load(cut, () => older.promise);
    const b = loader.load(cut, () => newer.promise);
    newer.resolve(loaded);
    await b;
    older.resolve(failed);
    await a;
    expect(states(published), "GMAIL_REST_TICKET").toEqual([`${RAFT}:loading`, `${RAFT}:loading`, `${RAFT}:loaded`]);
    expect(published.at(-1)?.[1].rest?.endsWith(REST_MARK)).toBe(true);
  });

  test("an answer that arrives after the card is gone sets nothing, and closing cancels the request", async () => {
    const published: [string, BodyDetail][] = [];
    const loader = createBodyLoader((id, detail) => published.push([id, detail]));
    const late = deferred<GmailBodyResult>();
    let signal: AbortSignal | undefined;
    const pending = loader.load(cut, (s) => ((signal = s), late.promise));
    loader.close();
    expect(signal?.aborted, "closing cancels the request").toBe(true);
    // A transport that ignores the cancel still answers: nothing may land.
    late.resolve(loaded);
    await pending;
    expect(states(published), "GMAIL_REST_NOTHING_AFTER_UNMOUNT").toEqual([`${RAFT}:loading`]);
    await loader.load(cut, () => Promise.resolve(loaded));
    expect(states(published), "a closed loader starts nothing").toEqual([`${RAFT}:loading`]);
  });
});
