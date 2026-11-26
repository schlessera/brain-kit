// The host Gmail read tools' results as the ui-kit Gmail components (#4210):
// every spelling on both backends, both views of search, thread and message
// read from recorded payloads, the label list, the fallback, the tool row's
// effect class and view, and the rest of a cut body from the display-only
// detail route: what it asks, how its answers and errors read, the prefix
// check, and that the loaded text never reaches the chat store a turn is
// built from. Props-only, keyless, mounted in happy-dom.
import { registerGmailToolsDom, unregisterGmailToolsDom } from "./gmail-tools-dom.js";

registerGmailToolsDom();

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render as mount, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { visibleToolName, type ToolCallView } from "@schlessera/brain-ui-sdk/client";
import { GMAIL_TOOL_NAMES } from "@schlessera/brain-ui-sdk/tool-contracts";
import { resetToolRenderers, resolveToolRenderer } from "../../../ui-sdk/src/client/renderers.js";
import { registerBuiltinRenderers } from "../../src/components/chat/renderers/index.js";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import type { ToolCall } from "../../src/stores/chat-store.js";
import {
  HIDDEN_SUBJECT, RAFT, RAFT_FULL, RAFT_SHOWN, REST_MARK, SESSION,
  draftRead, labelsRead, messageRead, raftBody, refusal, searchPage, threadRead,
} from "../gmail-fixtures.js";

const roots: ReturnType<typeof createBrainUiRoot>[] = [];
const requested: { url: string; method: string }[] = [];
/** What the next detail-route call answers; the default is a 404 with no body. */
let answer: (url: string) => Response = () => new Response("{}", { status: 404 });
afterEach(async () => {
  await act(async () => {
    cleanup();
    for (const root of roots.splice(0)) root.dispose();
  });
  requested.length = 0;
  answer = () => new Response("{}", { status: 404 });
});
afterAll(async () => {
  await act(async () => cleanup());
  resetToolRenderers();
  await unregisterGmailToolsDom();
});

function render(ui: ReactElement, session: string | null = SESSION) {
  const root = createBrainUiRoot({
    storage: null,
    request: async (url, init) => {
      requested.push({ url: String(url), method: init?.method ?? "GET" });
      return answer(String(url));
    },
  });
  roots.push(root);
  // A session, so the rest of a body is possible: a test that sees no request
  // has proved the card did not ask, not that it could not.
  if (session) root.stores.chat.setState({ activeSessionId: session });
  return { view: mount(<BrainUiProvider root={root}>{ui}</BrainUiProvider>), root };
}

type Tool = "search" | "read";
const spellings = (tool: Tool) =>
  [
    [visibleToolName(GMAIL_TOOL_NAMES[tool], "claude"), "claude"],
    [visibleToolName(GMAIL_TOOL_NAMES[tool], "pi"), "pi"],
    [`mcp__brain_ui__${GMAIL_TOOL_NAMES[tool]}`, "claude"],
  ] as const;

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
const detailState = (view: RenderResult) => [...view.container.querySelectorAll("[data-gmail-detail]")].map((n) => n.getAttribute("data-gmail-detail"));
const detailCalls = () => requested.filter((r) => r.url.includes("/google/"));

/** Press, then wait for the section to leave `loading`: the answer has arrived and been drawn. */
async function press(view: RenderResult, target: HTMLElement) {
  await act(async () => fireEvent.click(target));
  for (let turn = 0; turn < 20 && detailState(view).includes("loading"); turn++) await act(async () => {});
  expect(detailState(view), "the request has answered").not.toContain("loading");
}
const showTheRest = (view: RenderResult) => view.getByRole("button", { name: /^Show the rest/ });

describe("binding", () => {
  test("search and read resolve under every spelling, on both backends, to their Gmail renderers", () => {
    registerBuiltinRenderers();
    const labels: Record<Tool, string> = { search: "Gmail search", read: "Gmail" };
    for (const tool of ["search", "read"] as const) {
      for (const [name, backend] of spellings(tool)) {
        expect(resolveToolRenderer(call(name, undefined), backend)?.label, `${name} on ${backend}`).toBe(labels[tool]);
      }
    }
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

describe("labels and drafts", () => {
  test("the account's labels read as the kit's chips, system labels as words", () => {
    const { view } = output("read", labelsRead());
    expect([...view.container.querySelectorAll("[data-gmail-label]")].map((l) => l.textContent)).toEqual(["Inbox", "Family", "Raft"]);
  });

  test("a draft has no kit component yet, so it keeps the tool's own output", () => {
    const result = draftRead();
    const { view } = output("read", result);
    expect(view.container.querySelector("[data-gmail-message], [data-gmail-thread]")).toBeNull();
    expect(text(view)).toBe(JSON.stringify(result));
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

  test("the loaded rest never enters the chat store a turn is built from, and the 'Brain read' line stays", async () => {
    answer = () => Response.json(raftBody());
    const { view, root } = output("read", threadRead("content"));
    const before = JSON.stringify(root.stores.chat.getState());
    const brainRead = view.container.querySelector("[data-brain-read]")?.textContent;
    await press(view, showTheRest(view));
    expect(text(view), "the rest is on screen").toContain(REST_MARK);
    const after = JSON.stringify(root.stores.chat.getState());
    expect(after.includes(REST_MARK), "GMAIL_REST_NEVER_IN_TRANSCRIPT").toBe(false);
    expect(after, "GMAIL_REST_DISPLAY_ONLY").toBe(before);
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

  test("a search hit has no body, so a content search offers no rest", () => {
    const { view } = output("search", searchPage("content"), { input: SEARCH_INPUT });
    expect(view.container.querySelectorAll("[data-gmail-row='content']").length).toBe(3);
    expect(detailState(view)).toEqual([]);
  });
});
