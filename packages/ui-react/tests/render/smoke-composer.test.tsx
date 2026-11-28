// Render smoke tests for chat and activity views, the composer and new chats: mount the components in happy-dom and
// assert the DOM they produce. Fixtures are minimal and keyless; nothing here
// touches the network. Shared setup: ./smoke-harness.tsx.
//
// The DOM module import MUST stay first: it registers the happy-dom globals
// before the component module bodies run (./dom.ts explains why, and why
// `screen` must not be used).
import { registerSmokeComposerDom, unregisterSmokeComposerDom } from "./smoke-composer-dom.js";
registerSmokeComposerDom();

import { installSmokeHarness, PageSocket, changeControlledInput, flushPromises, render } from "./smoke-harness.js";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { READING_COLUMN_ATTR } from "../../src/lib/client-environment.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { activeChat } from "../../src/stores/chat-store.js";
import { Composer } from "../../src/components/chat/composer.js";
import { SessionList } from "../../src/components/chat/session-list.js";
import { WelcomeState } from "../../src/components/chat/welcome-state.js";
import { ComposerView } from "../../src/components/chat/composer-view.js";
import { AttachmentCount, ThinkingBlock, TurnHeader, UserTurn } from "../../src/components/chat/transcript-turn.js";
import { HistoryRow, IntentCard, LiveRunCard, RunRollupReceipt, toolState } from "../../src/components/activity/activity-views.js";
import { trackView } from "../track-fixtures.js";

installSmokeHarness(unregisterSmokeComposerDom);

/* ── S7 (activity): the rows render from props on the kit cards ──────────── */

describe("activity views", () => {
  test("a live run is an AgentRunCard inside a named button, with the tool strip from its children", () => {
    expect(toolState(undefined)).toBe("active");
    expect(toolState("success")).toBe("done");
    expect(toolState("error")).toBe("failed");
    const onOpen = mock(() => {});
    const view = render(<LiveRunCard name="nightly-sync" current="WebFetch" elapsed="1m 12s" tools={[{ label: "brain_search", state: "done" }, { label: "WebFetch", state: "active" }]} onOpen={onOpen} />);
    fireEvent.click(view.getByRole("button", { name: "Open run nightly-sync" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(view.getByText("nightly-sync")).toBeTruthy();
    expect(view.getByText("1m 12s")).toBeTruthy();
    // The current step is the quoted task line AND the active entry of the strip.
    expect(view.getAllByText(/▸ WebFetch/)).toHaveLength(2);
    expect(view.getByText(/brain_search/)).toBeTruthy();
    view.unmount();
  });

  test("history is a plain ListRow; failure colours it and names the outcome", () => {
    const onOpen = mock(() => {});
    const ok = render(<HistoryRow name="ledger_sync" cron outcome="success" meta="$0.02 · 4s · 2h ago" onOpen={onOpen} />);
    fireEvent.click(ok.getByRole("button", { name: /ledger_sync/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(ok.queryByText("success")).toBeNull();
    ok.unmount();
    const failed = render(<HistoryRow name="ledger_sync" cron={false} outcome="error" meta="— · 4s · 2h ago" onOpen={onOpen} />);
    expect(failed.getByText("error")).toBeTruthy();
    expect(failed.getByText("— · 4s · 2h ago")).toBeTruthy();
    failed.unmount();
  });

  test("an intent is an ActionCard whose Dismiss does not also open it", () => {
    const onOpen = mock(() => {}); const onDismiss = mock(() => {});
    const intent = { id: 1, runId: "r", spanId: null, kind: "failure" as const, tag: "t", title: "ledger sync keeps failing", body: "3 tries", status: "sent" as const, acknowledged: false, createdAt: 1 };
    const view = render(<IntentCard intent={intent} when="4m ago" onOpen={onOpen} onDismiss={onDismiss} />);
    expect(view.getByText("Failed")).toBeTruthy();
    expect(view.getByText("3 tries")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(0);
    fireEvent.click(view.getByText("ledger sync keeps failing"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    view.unmount();
    const stuck = render(<IntentCard intent={{ ...intent, kind: "stuck" }} when="now" onOpen={onOpen} onDismiss={onDismiss} />);
    expect(stuck.getByText("Stuck")).toBeTruthy();
    stuck.unmount();
  });

  test("the rollup receipt lists the run's facts and carries the failure reason as its footnote", () => {
    const view = render(<RunRollupReceipt origin="cron" outcome="error" when="2h ago" duration="4s" listCost="$0.10" effectiveCost="$0.02" billing="API billed" estimated usage="1.2k tok" failureReason="invoice source unreachable" />);
    expect(view.getByText("origin")).toBeTruthy();
    expect(view.getByText("cron")).toBeTruthy();
    expect(view.getByText("error")).toBeTruthy();
    expect(view.getByText(/\$0\.02 · API billed · ~ estimated rates/)).toBeTruthy();
    expect(view.getByText("invoice source unreachable")).toBeTruthy();
    view.unmount();
    const clean = render(<RunRollupReceipt origin="session" outcome="success" when="now" duration={null} listCost="—" effectiveCost="—" billing={null} estimated={false} usage={null} failureReason={null} />);
    expect(clean.queryByText(/this file only/)).toBeNull();
    clean.unmount();
  });
});

/* ── S7 (chat): the session list and the welcome state render from props ── */

describe("chat views", () => {
  test("the session list is card rows: Working first and listed once, selection, run state, warning with retry, empty", () => {
    const onNew = mock(() => {}); const onResume = mock((_id: string) => {}); const onRetry = mock(() => {});
    const onOpenTracker = mock((_id: string) => {});
    const groups = [{ label: "Today", sessions: [
      { id: "a", title: "Lisbon venues", when: "2h ago", cost: "$0.12", run: "streaming" as const },
      { id: "b", title: null, when: "3h ago", cost: null, run: "queued" as const, note: "queue is heavy" },
      { id: "z", title: "Raft timber tally", when: "1h ago", cost: null, run: null },
      { id: "y", title: "Rename voyage photos", when: "5h ago", cost: null, run: null, unseen: true },
    ] }];
    const working = [{ id: "z", label: "Raft timber tally", word: "running · 2m", tone: "amber" as const, icon: "working" as const, name: "Raft timber tally, running, 2m. Open session." }];
    const view = render(<SessionList working={working} groups={groups} loading={false} warning={null} currentSessionId="a" onNew={onNew} onResume={onResume} onOpenTracker={onOpenTracker} onRetry={onRetry} />);
    expect(view.getByText("Today")).toBeTruthy();
    const current = view.getByRole("button", { name: /Lisbon venues/ });
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(view.getByText("2h ago · $0.12")).toBeTruthy();
    expect(view.getByText("running")).toBeTruthy();
    expect(view.getByText("queued")).toBeTruthy();
    // A tracked session is in Working, not again in its date group (D52 §8);
    // one past the pill cap keeps `unseen` on its date row (D52 §4).
    const tracked = view.getAllByRole("button").filter((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").includes("Raft timber tally"));
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.closest("[data-working-group]")).not.toBeNull();
    expect(view.getByRole("button", { name: /Rename voyage photos/ }).textContent).toContain("unseen");
    fireEvent.click(tracked[0]!);
    expect(onOpenTracker).toHaveBeenLastCalledWith("z");
    fireEvent.click(view.getByRole("button", { name: /Untitled/ }));
    expect(onResume).toHaveBeenLastCalledWith("b");
    // One tab stop across the list: the session in view.
    expect(view.getAllByRole("button").filter((b) => b.getAttribute("tabindex") === "0" && b.closest("[data-session-item]")).map((b) => b.textContent)).toEqual([current.textContent]);
    fireEvent.click(view.getByRole("button", { name: "New conversation" }));
    expect(onNew).toHaveBeenCalledTimes(1);
    view.unmount();

    // At ≥1280 in an empty chat: aria-disabled, its reason printed at rest.
    const fresh = render(<SessionList groups={groups} loading={false} warning={null} currentSessionId={null} newWhy="already a new chat" onNew={onNew} onResume={onResume} onRetry={onRetry} />);
    const start = fresh.getByRole("button", { name: /New conversation/ });
    expect(start.getAttribute("aria-disabled")).toBe("true");
    expect(start.textContent).toContain("already a new chat");
    fireEvent.click(start);
    expect(onNew).toHaveBeenCalledTimes(1);
    fresh.unmount();

    const warned = render(<SessionList groups={[]} loading={false} warning="Could not refresh sessions. Please retry." currentSessionId={null} onNew={onNew} onResume={onResume} onRetry={onRetry} />);
    expect(warned.getByRole("status").textContent).toContain("Could not refresh");
    fireEvent.click(warned.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(warned.getByText("No sessions available")).toBeTruthy();
    warned.unmount();

    const loading = render(<SessionList groups={[]} loading warning={null} currentSessionId={null} onNew={onNew} onResume={onResume} onRetry={onRetry} />);
    expect(loading.queryByText("No sessions yet")).toBeNull();
    loading.unmount();
  });

  test("the welcome state is a kit EmptyState with suggestion chips that route actions", () => {
    const onAction = mock((_a: string) => {});
    const view = render(<WelcomeState onAction={onAction} />);
    expect(view.getByText("What do you need to know?")).toBeTruthy();
    // D52 §1: the briefing (keyless, so no cost, #1391), Search, and Add a
    // note, which replaced the statistics chip.
    const chips = view.getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["What's new?", "Search…", "Add a note…"]);
    fireEvent.click(chips[0]!);
    expect(onAction).toHaveBeenLastCalledWith("whatsup");
    fireEvent.click(chips[1]!);
    expect(onAction).toHaveBeenLastCalledWith("search");
    fireEvent.click(chips[2]!);
    expect(onAction).toHaveBeenLastCalledWith("add");
    expect(view.queryByText("Brain stats")).toBeNull();
    view.unmount();

    // Unavailable: the chip stays, keeps its cost, prints why, and does not run.
    onAction.mockClear();
    const offline = render(<WelcomeState onAction={onAction} briefingWhy="needs the host" />);
    const briefing = offline.getAllByRole("button")[0]!;
    expect(briefing.getAttribute("aria-disabled")).toBe("true");
    expect(briefing.textContent).not.toContain("spends");
    expect(briefing.textContent).toContain("needs the host");
    fireEvent.click(briefing);
    expect(onAction).not.toHaveBeenCalled();
    offline.unmount();
  });

  // With no cost chip (#1391) the briefing's reason is the only thing that
  // makes its chip wrap, so reconnecting changes its style on a rerender. The
  // chip must not drop a rowGap beside a gap shorthand: React reports that
  // as a console error, and the capture suite fails on browser faults.
  test("the briefing chip reconnects without a conflicting-style error", () => {
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
    try {
      const view = render(<WelcomeState onAction={() => {}} briefingWhy="needs the host" />);
      expect(view.getAllByRole("button")[0]!.textContent).toContain("needs the host");
      view.rerender(<WelcomeState onAction={() => {}} />);
      expect(view.getAllByRole("button")[0]!.textContent).toBe("What's new?");
      view.rerender(<WelcomeState onAction={() => {}} briefingWhy="a turn is running" />);
      expect(view.getAllByRole("button")[0]!.textContent).toContain("a turn is running");
      view.unmount();
      expect(errors.filter((e) => /style property during rerender/.test(e))).toEqual([]);
    } finally { spy.mockRestore(); }
  });
});

test("the composer picker displays Haiku 5.5 and sends its canonical selection", async () => {
  const providers = [
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", thinkingLevel: "medium", supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
  ];
  const root = createBrainUiRoot({ storage: null, request: async () => Response.json({ providers }) });
  await root.stores.provider.getState().loadProviders();
  root.stores.connection.setState({ wsStatus: "connected", chatRequestAck: true });
  const sent: Array<import("@schlessera/brain-ui-sdk/protocol").ClientChatMessage> = [];
  const view = render(<BrainUiProvider root={root}><Composer send={msg => { if (msg.type === "chat_message") sent.push(msg); return true; }} /></BrainUiProvider>);
  try {
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(view.getByRole("button", { name: /^Model —/ }));
    expect(view.getAllByRole("radio").length).toBeGreaterThan(0);
    fireEvent.click(view.getByRole("radio", { name: "Claude Haiku 5.5" }));
    expect(root.stores.provider.getState().selectedId).toBe("claude-haiku-5-5");
    expect(view.getByRole("button", { name: /Model — Claude Haiku 5.5/ })).toBeTruthy();
    const field = view.getByRole("textbox") as HTMLTextAreaElement;
    field.focus(); changeControlledInput(field, "Tell Odysseus about Ithaca.");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(sent).toHaveLength(1); expect(sent[0]!.providerId).toBe("claude-haiku-5-5");
    expect(sent[0]!.text).toBe("Tell Odysseus about Ithaca.");
  } finally { view.unmount(); root.dispose(); }
});

describe("one-message composer effort", () => {
  async function mounted(ack = true) {
    const providers = [
      { id: "claude", label: "Claude", thinkingLevel: "low", supportedThinkingLevels: ["low", "medium", "high", "xhigh", "max"] },
      { id: "smaller", label: "Smaller", thinkingLevel: "medium", supportedThinkingLevels: ["low", "medium", "high"] },
      { id: "plain", label: "Plain" },
    ];
    const root = createBrainUiRoot({ storage: null, request: async () => Response.json({ providers }) });
    await root.stores.provider.getState().loadProviders();
    root.stores.connection.setState({ wsStatus: "connected", chatRequestAck: ack });
    const sent: Array<import("@schlessera/brain-ui-sdk/protocol").ClientChatMessage> = [];
    const view = render(<BrainUiProvider root={root}><Composer send={(msg) => { if (msg.type === "chat_message") sent.push(msg); return true; }} /></BrainUiProvider>);
    await act(async () => { await Promise.resolve(); });
    const choose = (level: string) => {
      fireEvent.click(view.getByRole("button", { name: /^Model —/ }));
      fireEvent.click(view.getByRole("radio", { name: level }));
    };
    const field = () => view.getByRole("textbox") as HTMLTextAreaElement;
    const type = (text: string) => { field().focus(); changeControlledInput(field(), text); };
    const send = () => { field().focus(); fireEvent.keyDown(field(), { key: "Enter" }); };
    return { root, view, sent, choose, field, type, send, done() { view.unmount(); root.dispose(); } };
  }

  test("a send empties the field into its snapshot; refusal gives draft and effort back; acknowledgement consumes them", async () => {
    const h = await mounted();
    try {
      h.choose("max"); h.type("first"); h.send();
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].thinkingLevel).toBe("max");
      expect(h.view.getByRole("button", { name: "Model — Claude · effort max for the next message" })).toBeTruthy();
      // D52 §5: what was sent is a snapshot apart from the draft.
      expect(h.field().value).toBe("");
      act(() => h.root.connection.handleServerMessage({ type: "error", code: "SESSION_LIMIT", message: "Try again", requestId: h.sent[0].requestId }));
      // Refused, so nothing was consumed: the words come back.
      expect(h.field().value).toBe("first");
      expect(h.view.getByText("· max")).toBeTruthy();
      h.send();
      expect(h.sent).toHaveLength(2);
      expect(h.sent[1].thinkingLevel).toBe("max");
      act(() => h.root.connection.handleServerMessage({ type: "session_info", sessionId: "effort-ui", isNew: true, providerId: "claude", requestId: h.sent[1].requestId, draftId: h.sent[1].draftId }));
      expect(h.field().value).toBe("");
      expect(h.view.queryByText("· max")).toBeNull();
      h.type("second"); h.send();
      expect(h.sent).toHaveLength(3);
      expect(h.sent[2].thinkingLevel).toBeUndefined();
      expect(h.sent[2].requestId).toBeDefined();
    } finally { h.done(); }
  });

  test("an interrupted acknowledgement holds the send for review: nothing is resent until Send again, and Edit puts it back", async () => {
    const h = await mounted();
    try {
      h.choose("high"); h.type("unconfirmed"); h.send();
      act(() => h.root.stores.connection.getState().setWsStatus("disconnected"));
      expect(h.sent).toHaveLength(1);
      const held = () => Object.values(h.root.stores.drafts.getState().sends).filter((s) => s.state === "unconfirmed");
      expect(held().map((s) => s.text)).toEqual(["unconfirmed"]);
      expect(h.field().value).toBe("");
      expect(h.view.getByText("· high")).toBeTruthy();
      act(() => h.root.stores.connection.getState().setWsStatus("connected"));
      expect(h.sent).toHaveLength(1);
      // Send again: the same snapshot under a new request id, effort included.
      // (The composer's own `send` is the host here, so the frame goes through the root.)
      const resent = held()[0]!;
      expect(resent.message.thinkingLevel).toBe("high");
      act(() => h.root.connection.handleServerMessage({ type: "error", code: "RATE_LIMITED", message: "Slow down" }));
      expect(held()).toHaveLength(1);
      act(() => h.root.stores.drafts.getState().editSend(resent.requestId));
      expect(h.field().value).toBe("unconfirmed");
      expect(held()).toHaveLength(0);
      h.send();
      expect(h.sent).toHaveLength(2);
      expect(h.sent[1].thinkingLevel).toBe("high");
      expect(h.sent[1].requestId).not.toBe(h.sent[0].requestId);
    } finally { h.done(); }
  });

  test("a refused queued override preserves the current reply and draft", async () => {
    const h = await mounted();
    try {
      act(() => {
        const chat = h.root.stores.chat.getState();
        chat.setActiveSession("effort-ui");
        chat.setMessages("effort-ui", []);
        chat.startAssistantMessage("effort-ui", "running-turn");
        chat.setRunState("effort-ui", "streaming");
        h.root.stores.provider.getState().setPinned("claude");
      });
      h.choose("high"); h.type("queued"); h.send();
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0].thinkingLevel).toBe("high");
      act(() => h.root.connection.handleServerMessage({ type: "error", code: "SESSION_QUEUE_FULL", message: "Queue full", sessionId: "effort-ui", requestId: h.sent[0].requestId }));
      expect(h.field().value).toBe("queued");
      expect(h.view.getByText("· high")).toBeTruthy();
      const state = h.root.stores.chat.getState();
      expect(state.buffers["effort-ui"].isStreaming).toBe(true);
      expect(state.buffers["effort-ui"].messages.filter((message) => message.role === "assistant")).toHaveLength(1);
      expect(state.runStates["effort-ui"]).toBe("streaming");
      act(() => h.root.connection.handleServerMessage({ type: "error", code: "agent_error", message: "Failed run", sessionId: "effort-ui", turnId: "running-turn", requestId: "running-request" }));
      expect(h.root.stores.chat.getState().buffers["effort-ui"].isStreaming).toBe(false);
      expect(h.root.stores.chat.getState().runStates["effort-ui"]).toBeUndefined();
    } finally { h.done(); }
  });

  test("queue acknowledgement consumes the sent override and preserves a newly chosen effort and edited draft", async () => {
    const h = await mounted();
    try {
      act(() => { h.root.stores.chat.getState().setActiveSession("effort-ui"); h.root.stores.chat.getState().setMessages("effort-ui", []); h.root.stores.provider.getState().setPinned("claude"); });
      h.choose("high"); h.type("queued"); h.send();
      expect(h.sent).toHaveLength(1);
      h.choose("max"); h.type("another message");
      act(() => h.root.connection.handleServerMessage({ type: "status", status: "queued", sessionId: "effort-ui", requestId: h.sent[0].requestId }));
      expect(h.field().value).toBe("another message");
      expect(h.view.getByText("· max")).toBeTruthy();
      h.send();
      expect(h.sent[1].thinkingLevel).toBe("max");
      act(() => h.root.connection.handleServerMessage({ type: "status", status: "queued", sessionId: "effort-ui", requestId: h.sent[1].requestId }));
      expect(h.field().value).toBe("");
      expect(h.view.queryByText("· max")).toBeNull();
    } finally { h.done(); }
  });

  test("a new chat whose first message is held for review sends nothing more until it is resolved", async () => {
    const h = await mounted();
    try {
      h.type("Which harbour?"); h.send();
      act(() => h.root.stores.connection.getState().setWsStatus("disconnected"));
      act(() => h.root.stores.connection.getState().setWsStatus("connected"));
      h.type("And the fees"); h.send();
      expect(h.sent, "a second first message would start a second conversation").toHaveLength(1);
      act(() => h.root.connection.drafts.edit(h.sent[0].requestId!));
      expect(h.field().value).toBe("Which harbour?\nAnd the fees");
      h.send();
      expect(h.sent).toHaveLength(2);
    } finally { h.done(); }
  });

  test("a held send accepted after Send again consumes the effort it carried", async () => {
    const h = await mounted();
    try {
      act(() => { h.root.stores.chat.getState().setActiveSession("effort-ui"); h.root.stores.chat.getState().setMessages("effort-ui", []); h.root.stores.provider.getState().setPinned("claude"); });
      h.choose("high"); h.type("queued"); h.send();
      act(() => h.root.stores.connection.getState().setWsStatus("disconnected"));
      act(() => h.root.stores.connection.getState().setWsStatus("connected"));
      expect(h.view.getByText("· high")).toBeTruthy();
      // Send again re-keys the snapshot; the host accepts the new request.
      act(() => { h.root.stores.drafts.getState().resend(h.sent[0].requestId!, "req-again"); });
      act(() => h.root.connection.handleServerMessage({ type: "status", status: "queued", sessionId: "effort-ui", requestId: "req-again" }));
      expect(h.view.queryByText("· high")).toBeNull();
    } finally { h.done(); }
  });

  test("an acknowledgement that empties the session's draft keeps an effort chosen meanwhile", async () => {
    const h = await mounted();
    try {
      act(() => { h.root.stores.chat.getState().setActiveSession("effort-ui"); h.root.stores.chat.getState().setMessages("effort-ui", []); h.root.stores.provider.getState().setPinned("claude"); });
      h.choose("high"); h.type("queued"); h.send();
      h.choose("max");
      // Nothing typed since: acceptance forgets the emptied draft, and the
      // view's draft id changes, inside the same session (#951).
      act(() => h.root.connection.handleServerMessage({ type: "status", status: "queued", sessionId: "effort-ui", requestId: h.sent[0].requestId }));
      expect(h.view.getByText("· max")).toBeTruthy();
    } finally { h.done(); }
  });

  test("a new conversation acknowledgement preserves effort chosen for the edited next draft", async () => {
    const h = await mounted();
    try {
      h.choose("high"); h.type("first"); h.send();
      expect(h.sent).toHaveLength(1);
      h.choose("max"); h.type("another message");
      act(() => h.root.connection.handleServerMessage({ type: "session_info", sessionId: "effort-ui", isNew: true, providerId: "claude", requestId: h.sent[0].requestId, draftId: h.sent[0].draftId }));
      expect(h.root.stores.chat.getState().activeSessionId).toBe("effort-ui");
      expect(h.field().value).toBe("another message");
      expect(h.view.getByText("· max")).toBeTruthy();
      h.send();
      expect(h.sent[1].thinkingLevel).toBe("max");
    } finally { h.done(); }
  });

  test("model changes downgrade visibly; an effort-less model drops the override; older hosts retain their send behavior", async () => {
    const h = await mounted();
    try {
      h.choose("max");
      fireEvent.click(h.view.getByRole("button", { name: /^Model —/ }));
      fireEvent.click(h.view.getByRole("radio", { name: "Smaller" }));
      expect(h.view.getByText("· high")).toBeTruthy();
      expect(h.view.getByText("Effort changed from max to high for this model")).toBeTruthy();
      expect(h.view.getByRole("button", { name: "Model — Smaller · effort high for the next message (max not supported)" })).toBeTruthy();
      fireEvent.click(h.view.getByRole("radio", { name: "Claude" }));
      expect((h.view.getByRole("radio", { name: "high" }) as HTMLInputElement).checked).toBe(true);
      expect((h.view.getByRole("radio", { name: "max" }) as HTMLInputElement).checked).toBe(false);
      fireEvent.click(h.view.getByRole("radio", { name: "Plain" }));
      expect(h.view.queryByText("Effort · next message")).toBeNull();
      expect(h.view.getByText("This model has no effort setting; the next message uses its default")).toBeTruthy();
    } finally { h.done(); }
    const old = await mounted(false);
    try {
      old.type("legacy"); old.send();
      expect(old.sent[0].requestId).toBeUndefined();
      expect(old.sent[0].thinkingLevel).toBeUndefined();
      expect(old.field().value).toBe("");
    } finally { old.done(); }
  });
});

describe("ComposerView", () => {
  const refs = { frameRef: { current: null }, providerMenuRef: { current: null } };
  const handlers = () => ({
    onChange: mock((_v: string) => {}), onSend: mock(() => {}), onStop: mock(() => {}), onMic: mock(() => {}), onPasteFiles: mock((_f: File[]) => {}),
    onAttachToggle: mock(() => {}), onPickLibrary: mock(() => {}), onPickCamera: mock(() => {}), onRecall: mock(() => {}), onEscape: mock(() => {}),
    onRemoveAttachment: mock((_i: number) => {}), onDismissErrors: mock(() => {}), onProviderToggle: mock(() => {}), onProviderSelect: mock((_id: string) => {}),
    onProviderDismiss: mock(() => {}), onEffortSelect: mock((_level: string | null) => {}),
  });
  const base = { placeholder: "Ask", state: "ready" as const, paletteOpen: false, palette: null, attachMenuOpen: false, attachments: [], attachErrors: [], provider: null, ...refs };

  test("the field is the kit composer: send, provider, attach menu, recall and escape route to the container", () => {
    const h = handlers();
    const view = render(<ComposerView {...base} value="hello" paletteOpen attachMenuOpen provider={{ label: "Fast model", locked: false, menuOpen: true, options: [{ id: "a", label: "Fast model" }, { id: "b", label: "Careful model" }], selectedId: "a" }} {...h} />);
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(h.onSend).toHaveBeenCalledTimes(1);
    const field = view.getByLabelText("Ask") as HTMLTextAreaElement;
    field.focus();
    changeControlledInput(field, "hello there");
    expect(h.onChange).toHaveBeenCalledWith("hello there");
    // esc dismisses the slash palette; the kit's own esc only stops a stream.
    fireEvent.keyDown(field, { key: "Escape" });
    expect(h.onEscape).toHaveBeenCalledTimes(1);
    // The paperclip is a menu trigger (D37): the menu carries the capture choices.
    expect(view.getByRole("button", { name: "Attach — photo, camera, files" }).getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(view.getByRole("button", { name: "Attach — photo, camera, files" }));
    expect(h.onAttachToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: /^Photo library/ }));
    fireEvent.click(view.getByRole("button", { name: /^Camera/ }));
    expect(h.onPickLibrary).toHaveBeenCalledTimes(1);
    expect(h.onPickCamera).toHaveBeenCalledTimes(1);
    // The provider chip lives in the kit's hint line; the list is the frame's.
    fireEvent.click(view.getByRole("button", { name: "Model — Fast model" }));
    expect(h.onProviderToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("radio", { name: "Careful model" }));
    expect(h.onProviderSelect).toHaveBeenCalledWith("b");
    view.unmount();

    const empty = render(<ComposerView {...base} value="" {...h} />);
    fireEvent.keyDown(empty.getByLabelText("Ask"), { key: "ArrowUp" });
    expect(h.onRecall).toHaveBeenCalledTimes(1);
    empty.unmount();

    const streaming = render(<ComposerView {...base} value="" state="streaming" hint="Will queue · esc or the stop button ends the run" provider={{ label: "Pinned model", locked: true, menuOpen: false, options: [], selectedId: null }} {...h} />);
    fireEvent.click(streaming.getByRole("button", { name: "Stop generating" }));
    expect(h.onStop).toHaveBeenCalledTimes(1);
    expect(streaming.queryByRole("button", { name: "Send" })).toBeNull();
    expect(streaming.getByText(/Will queue/)).toBeTruthy();
    // A pinned provider is text, not a control.
    expect(streaming.queryByRole("button", { name: /Pinned model/ })).toBeNull();
    expect(streaming.getByText("Pinned model")).toBeTruthy();
    streaming.unmount();
  });

  test("the paperclip names its menu, and live conversation is the mic's hold, not a row (#3045, #3693)", () => {
    const h = handlers();
    const name = "Attach — photo, camera, files";
    const view = render(<ComposerView {...base} value="" attachMenuOpen onPickTracks={mock(() => {})} micControl={<button type="button" aria-label="Dictate" data-caller-mic="" />} {...h} />);
    const trigger = view.getByRole("button", { name });
    // The tooltip paints the name itself, hidden from the accessibility tree so it is heard once.
    expect(trigger.querySelector("[data-composer-tip]")?.textContent).toBe(name);
    expect(trigger.querySelector("[data-composer-tip]")?.getAttribute("aria-hidden")).toBe("true");
    expect(view.queryByRole("button", { name: /live conversation/i })).toBeNull();
    // The caller's mic takes the kit's mic slot.
    expect(view.container.querySelectorAll("[data-composer-mic] [data-caller-mic]")).toHaveLength(1);
    view.unmount();

    // Dictating: the trigger is inert, with no name and no tooltip.
    const dictating = render(<ComposerView {...base} value="" state="dictating" {...h} />);
    expect(dictating.queryByRole("button", { name: /^Attach/ })).toBeNull();
    expect(dictating.container.querySelector("[data-composer-tip]")).toBeNull();
    dictating.unmount();
  });

  test("attachments, their errors and a lost connection", () => {
    const h = handlers();
    const view = render(<ComposerView {...base} value="" state="offline" placeholder="Connecting..." blockedWhy="needs the host · your draft is kept" attachments={[{ previewUrl: "blob:one", name: "one.png" }]} attachErrors={["big.png: too large"]} {...h} />);
    // Offline keeps the draft typeable; only the send is inert, with the reason printed.
    expect((view.getByLabelText("Connecting...") as HTMLTextAreaElement).readOnly).toBe(false);
    expect(view.getByText("needs the host · your draft is kept")).toBeTruthy();
    expect(view.getByRole("alert").textContent).toContain("big.png: too large");
    fireEvent.click(view.getByRole("button", { name: "Dismiss" }));
    expect(h.onDismissErrors).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole("button", { name: "Remove one.png" }));
    expect(h.onRemoveAttachment).toHaveBeenCalledWith(0);
    expect(view.getByRole("button", { name: "Send — unavailable" }).getAttribute("aria-disabled")).toBe("true");
    view.unmount();
  });
});

describe("transcript turn views", () => {
  test("the header names who and when; a voice turn's mark is inline, not in the header", () => {
    const view = render(<TurnHeader who="You" when="09:41" tone="user" />);
    expect(view.getByText("You")).toBeTruthy();
    expect(view.getByText("09:41")).toBeTruthy();
    expect(view.queryByRole("img")).toBeNull();
    view.unmount();
    const brain = render(<TurnHeader who="Brain" when="09:42" tone="brain" />);
    expect(brain.queryByRole("img")).toBeNull();
    brain.unmount();
  });

  test("a user turn wraps its content in the bubble; a resumed one counts its images", () => {
    const view = render(<UserTurn><p>hello</p></UserTurn>);
    const content = view.getByText("hello");
    const bubble = content.parentElement?.parentElement;
    expect(bubble?.style.maxWidth, "the content is inside the tucked user bubble").toBe("82%");
    expect(bubble?.style.borderBottomRightRadius).toBe("5px");
    expect(bubble?.parentElement?.style.alignItems, "the user bubble aligns right").toBe("flex-end");
    view.unmount();
    const spoken = render(<UserTurn spoken><span>hello</span></UserTurn>);
    expect(spoken.getByRole("img", { name: "Spoken by you" }).parentElement?.className, "a spoken turn is the kit's spoken bubble").toBe("bk-spoken-bubble");
    expect(spoken.getByText("hello").previousElementSibling?.className, "the mic leads the words").toBe("bk-spoken-mark");
    spoken.unmount();
    const count = render(<AttachmentCount count={2} />);
    expect(count.getByText("2 images")).toBeTruthy();
    count.unmount();
  });

  test("thinking streams open, then collapses into a disclosure the container controls", () => {
    const onOpenChange = mock((_o: boolean) => {});
    const live = render(<ThinkingBlock content="considering the loom" chars={80} streaming open onOpenChange={onOpenChange} />);
    expect(live.getByText("considering the loom")).toBeTruthy();
    expect(live.queryByRole("button")).toBeNull();
    live.unmount();
    const done = render(<ThinkingBlock content="considering the loom" chars={80} streaming={false} open={false} onOpenChange={onOpenChange} />);
    const summary = done.getByRole("button", { name: /Thought for ~20 tokens/ });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(done.queryByText("considering the loom")).toBeNull();
    fireEvent.click(summary);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    done.unmount();
  });
});

/* ── #93: New chat is a disc over the transcript, not a row above it ─────── */

describe("New chat on the chat page (#93)", () => {
  function mountChat(seed: boolean) {
    globalThis.fetch = (async () =>
      Response.json({ entries: [], providers: [], backends: {}, slugs: {}, models: [], sessions: [] })) as unknown as typeof fetch;
    globalThis.WebSocket = PageSocket as unknown as typeof WebSocket;
    const root = createBrainUiRoot({ storage: null });
    const release = root.connection.connect();
    if (seed) {
      act(() => {
        root.stores.chat.getState().addUserMessage(null, "What did Circe say about the strait?", "typed");
      });
    }
    const view = render(<BrainUiProvider root={root}><ChatPage /></BrainUiProvider>);
    return {
      root,
      view,
      done: () => {
        view.unmount();
        release();
        root.dispose();
      },
    };
  }

  test("it is drawn inside the message area, icon-only, and no row above the transcript remains", async () => {
    const { view, done } = mountChat(true);
    try {
      await act(flushPromises);
      // The transcript is there, so the conversation the button leaves is too.
      expect(view.container.textContent).toContain("What did Circe say about the strait?");
      const button = view.getByRole("button", { name: "New chat" });

      // The kit's disc row (D52 §7) is a sibling of the transcript's
      // scroller, inside the positioned message area, anchored to its top
      // right.
      const scroller = view.container.querySelector(`[${READING_COLUMN_ATTR}]`)!.parentElement!;
      const area = scroller.parentElement!;
      const row = button.parentElement!;
      expect(row.className).toBe("bk-disc-row");
      expect(row.parentElement === area).toBe(true);
      expect(area.className.split(" ")).toContain("relative");
      expect(scroller.className.split(" ")).toEqual(
        expect.arrayContaining(["pt-10", "@min-[888px]:pt-0"])
      );
      expect([row.style.position, row.style.right, row.style.top]).toEqual(["absolute", "16px", "10px"]);
      // Named by aria-label. The word the pill opens to is the same word,
      // hidden from assistive technology, so there is no title to repeat it.
      expect(button.className).toBe("bk-disc");
      expect(button.getAttribute("title")).toBe(null);
      const word = button.querySelector(".bk-disc-label")!;
      expect(word.textContent).toBe("New chat");
      expect(word.getAttribute("aria-hidden")).toBe("true");
      expect(button.querySelector("svg") !== null).toBe(true);
      // Ink at rest: the primary act (D52 §8).
      expect(button.getAttribute("data-tone")).toBe("ink");
      expect(button.firstElementChild!.className).toBe("bk-disc-paint");

      // The page column holds the message area directly after the panels:
      // nothing in flow between them takes the transcript's height.
      const column = area.parentElement!;
      const inFlow = [...column.children].filter((el) => el.className.split(" ").includes("shrink-0"));
      expect(inFlow).toEqual([]);
    } finally {
      done();
    }
  });

  test("one activation starts a new chat, and with no conversation there is no button", async () => {
    const { root, view, done } = mountChat(true);
    try {
      await act(flushPromises);
      expect(activeChat(root.stores.chat.getState()).messages).toHaveLength(1);
      fireEvent.click(view.getByRole("button", { name: "New chat" }));
      expect(activeChat(root.stores.chat.getState()).messages).toHaveLength(0);
      expect(view.queryByRole("button", { name: "New chat" }) === null).toBe(true);
    } finally {
      done();
    }
  });

  test("a chat with no messages mounts without it", async () => {
    const { view, done } = mountChat(false);
    try {
      await act(flushPromises);
      expect(view.queryByRole("button", { name: "New chat" }) === null).toBe(true);
    } finally {
      done();
    }
  });
});

describe("composer track intake", () => {
  async function mountedTracks() {
    const upload: Array<{ init: RequestInit; resolve: (response: Response) => void }> = [];
    const root = createBrainUiRoot({ storage: null, request: async (url, init) => {
      if (url.endsWith("/track-upload")) return new Promise<Response>(resolve => upload.push({ init: init!, resolve }));
      return Response.json({ providers: [] });
    } });
    root.stores.connection.setState({ wsStatus: "connected", chatRequestAck: true });
    const sent: Array<import("@schlessera/brain-ui-sdk/protocol").ClientChatMessage> = [];
    const view = render(<BrainUiProvider root={root}><Composer send={message => { if (message.type === "chat_message") sent.push(message); return true; }} /></BrainUiProvider>);
    await act(async () => { await Promise.resolve(); });
    const field = () => view.getByRole("textbox") as HTMLTextAreaElement;
    const type = (text: string) => { field().focus(); changeControlledInput(field(), text); };
    const send = () => { field().focus(); fireEvent.keyDown(field(), { key: "Enter" }); };
    const pick = (names: string[]) => {
      const input = view.container.querySelector<HTMLInputElement>('input[accept*=".gpx"]');
      expect(input).not.toBeNull();
      fireEvent.change(input!, { target: { files: names.map(name => new File(['{"type":"LineString","coordinates":[[3,2],[3.01,2]]}'], name, { type: "application/octet-stream" })) } });
    };
    const ready = (index: number, name: string) => {
      const file = trackView().file; file.incomingName = name; file.name = name + ".geojson"; file.path = file.path.replace("ithaca-loop.geojson", file.name); file.summary!.source.path = file.path;
      upload[index]!.resolve(Response.json({ files: [file] }));
    };
    return { root, view, upload, sent, field, type, send, pick, ready, done() { view.unmount(); root.dispose(); } };
  }

  test("the real picker holds a mixed draft until all track results are ready and acknowledgement consumes only submitted chips", async () => {
    const h = await mountedTracks();
    try {
      h.type("Show these loops"); h.pick(["Ithaca loop", "Raft route"]);
      expect(h.upload).toHaveLength(2);
      expect(h.view.getByRole("button", { name: "Remove Ithaca loop" })).toBeTruthy();
      h.send(); expect(h.sent).toHaveLength(0); expect(h.view.container.textContent).toContain("sends when 2 files finish");
      await act(async () => h.ready(0, "Ithaca loop"));
      expect(h.sent).toHaveLength(0); h.type("Show these loops with a revised draft");
      await act(async () => h.ready(1, "Raft route"));
      await waitFor(() => expect(h.sent).toHaveLength(1));
      expect(h.sent[0]!.text).toBe("Show these loops with a revised draft");
      expect(h.sent[0]!.files).toHaveLength(2); expect(h.sent[0]!.files![0]!.kind).toBe("file");
      expect(h.sent[0]!.files![0]!.path).toContain("Ithaca loop.geojson");
      const user = h.root.stores.chat.getState().draft!.messages.find(message => message.role === "user");
      expect(user!.files).toHaveLength(2); expect(user!.files![0]!.summary!.measurements.distance.value!).toBeGreaterThan(9900);
      h.type("Next draft"); h.pick(["Next track"]);
      await act(async () => h.ready(2, "Next track"));
      // The host's acceptance, as the socket delivers it (#951: the draft
      // client settles sends from frames, and the new chat becomes its session).
      act(() => h.root.connection.handleServerMessage({ type: "session_info", sessionId: "track-ui", isNew: true, requestId: h.sent[0]!.requestId!, draftId: h.sent[0]!.draftId }));
      expect(h.field().value).toBe("Next draft");
      expect(h.view.queryByRole("button", { name: "Remove Ithaca loop" })).toBeNull();
      expect(h.view.getByRole("button", { name: "Remove Next track" })).toBeTruthy();
    } finally { h.done(); }
  });

  test("a send held for its tracks never sends another draft opened meanwhile", async () => {
    const h = await mountedTracks();
    try {
      h.type("Show this loop"); h.pick(["Ithaca loop"]); h.send();
      expect(h.view.container.textContent).toContain("sends when 1 file finishes");
      // Another new-chat draft opened from Sessions while the upload runs.
      act(() => {
        h.root.stores.drafts.getState().edit("d-letter", null, { text: "Letter to Penelope" });
        h.root.stores.chat.getState().clearMessages();
        h.root.stores.drafts.getState().openUnbound("d-letter");
      });
      expect(h.sent, "nothing was pressed for the letter").toHaveLength(0);
      expect(h.field().value).toBe("Letter to Penelope");
      await act(async () => h.ready(0, "Ithaca loop"));
      expect(h.sent, "nothing was pressed for the letter, once the track is ready").toHaveLength(0);
    } finally { h.done(); }
  });

  test("a failed held track keeps the whole draft; retry does not send until the user asks, and removal aborts", async () => {
    const h = await mountedTracks();
    try {
      h.type("Keep this draft"); h.pick(["bad.json"]); h.send();
      await act(async () => h.upload[0]!.resolve(Response.json({ error: "unsupported_track" }, { status: 422 })));
      expect(h.sent).toHaveLength(0); expect(h.field().value).toBe("Keep this draft");
      expect(h.view.container.textContent).toContain("ordinary JSON"); expect(h.view.container.textContent).toContain("Your draft is kept");
      fireEvent.click(h.view.getByRole("button", { name: "Retry bad.json" })); expect(h.upload).toHaveLength(2);
      await act(async () => h.ready(1, "bad.json")); expect(h.sent).toHaveLength(0);
      h.send(); expect(h.sent).toHaveLength(1);
      h.pick(["Cancel track"]); expect(h.upload).toHaveLength(3);
      const signal = h.upload[2]!.init.signal;
      fireEvent.click(h.view.getByRole("button", { name: "Remove Cancel track" })); expect(signal!.aborted).toBe(true);
      await act(async () => h.ready(2, "Cancel track")); expect(h.view.queryByRole("button", { name: "Remove Cancel track" })).toBeNull(); expect(h.sent).toHaveLength(1);
    } finally { h.done(); }
  });
});
