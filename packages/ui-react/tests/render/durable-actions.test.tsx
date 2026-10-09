import { unregisterDurableActionsDom } from "./durable-actions-dom.js";
import { afterAll, afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ClientMessage, InboxActionItem, InboxQueueItem, InboxThread } from "@schlessera/brain-ui-sdk/protocol";
import { DecisionCard, DecisionDetail, NoteCard, OutcomeRow, ThreadHeader } from "../../src/components/activity/durable-actions.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { InFlightDecision, InboxOutcome } from "../../src/stores/inbox-store.js";

const roots: BrainUiRoot[] = [];
afterEach(() => { cleanup(); for (const root of roots.splice(0)) root.dispose(); });
afterAll(unregisterDurableActionsDom);

const T = Date.parse("2026-07-12T09:00:00Z");
const TITLE = "File the Ithaca harbour notice?";
const PATH = "finances/ithaca-port.md";
const thread: InboxThread = {
  id: "ithaca", trustClass: "untrusted", source: "share", status: "open",
  stateMd: "# Ithaca harbour\nPenelope forwarded the notice.", stakes: 1, createdAt: T, lastSeenAt: T,
};
const blocked: InboxQueueItem = {
  id: "port-work", dedupKey: "port-work", threadId: thread.id, queue: "queue", type: "triage", status: "blocked",
  blockedByItemId: "notice", version: 1, attempts: 0, maxAttempts: 3, createdAt: T, updatedAt: T, expiresAt: T + 86_400_000,
  payload: { stagingId: "ithaca-notice" },
};
const context = { thread, blocked, rank: 1, total: 2, compact: false };
function decision(patch: Partial<InboxActionItem> = {}): InboxActionItem {
  return {
    id: "notice", dedupKey: "notice", threadId: thread.id, queue: "actions", type: "approve", status: "pending",
    version: 1, createdAt: T, updatedAt: T, expiresAt: T + 86_400_000,
    payload: { title: TITLE, detail: "Penelope forwarded the port fee." },
    options: [
      { id: "file", label: "File it", effect: { kind: "enqueue", payload: { instruction: "Append the fee row", operation: {
        toolName: "Edit", targetPath: PATH, input: { path: PATH, append: "12 drachmas" },
      } } } },
      { id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } },
    ], ...patch,
  };
}
function mount(item = decision(), compact = false) {
  const root = createBrainUiRoot({ storage: null, request: async () => Response.json({}) });
  roots.push(root);
  root.stores.inbox.setState({ online: true, items: { [item.id]: item } });
  const frames: ClientMessage[] = [];
  let admit = true;
  root.connection.send = msg => { frames.push(msg); return admit; };
  const details: string[] = [], queue: string[] = [], decided: string[] = [];
  const card = (next: InboxActionItem) => <BrainUiProvider root={root}>
    <DecisionCard item={next} context={{ ...context, compact }} keys onDetails={() => details.push(next.id)}
      onQueue={id => queue.push(id)} onDecided={id => decided.push(id)} />
  </BrainUiProvider>;
  const view = render(card(item));
  return { root, view, frames, details, queue, decided, refuse: () => { admit = false; },
    revise: (next: InboxActionItem) => view.rerender(card(next)) };
}
const click = (m: ReturnType<typeof mount>, name: string | RegExp) => fireEvent.click(m.view.getByRole("button", { name }));
const disabled = (m: ReturnType<typeof mount>, name: string | RegExp) =>
  m.view.getByRole("button", { name }).getAttribute("aria-disabled") === "true";
const approve = /^Approve:/;

test("pending approval previews the stored effect and sends once, then records", () => {
  const m = mount();
  expect(m.view.container.textContent).toContain(PATH);
  expect(m.view.container.textContent).toContain("12 drachmas");
  click(m, approve);
  expect(m.frames).toEqual([{ type: "inbox_resolve", itemId: "notice", optionId: "file" }]);
  expect(m.decided).toEqual(["notice"]);
  expect(m.view.container.textContent).toContain("Recording…");
  expect(disabled(m, /Later:/)).toBe(true);
  click(m, /Recording…/);
  expect(m.frames).toHaveLength(1);
});

test("a refused transport leaves the pending decision answerable", () => {
  const m = mount(); m.refuse(); click(m, approve);
  expect(m.view.container.textContent).not.toContain("Recording…");
  expect(disabled(m, approve)).toBe(false);
  expect(m.decided).toEqual([]);
  expect(m.frames).toHaveLength(1);
});

test("choose requires a selection and applies that option", () => {
  const item = decision({ type: "choose" });
  item.options.splice(1, 0, { id: "cancel", label: "Cancel port work", effect: { kind: "cancel_blocked" } });
  const m = mount(item);
  expect(disabled(m, "Apply choice (pick an option first)")).toBe(true);
  fireEvent.click(m.view.getByRole("radio", { name: /Cancel port work/ }));
  expect(m.view.getByRole("radio", { name: /Cancel port work/ }).getAttribute("aria-checked")).toBe("true");
  click(m, /Apply: triage/);
  expect(m.frames).toEqual([{ type: "inbox_resolve", itemId: "notice", optionId: "cancel" }]);
});

test("dismiss confirmation keeps, toggles a reason, and sends the chosen reason", () => {
  const m = mount(); click(m, /Dismiss:/);
  expect(m.frames).toEqual([]);
  click(m, "Wrong call"); click(m, "Wrong call");
  expect(m.view.getByRole("button", { name: "Wrong call" }).getAttribute("aria-pressed")).toBe("false");
  click(m, "Wrong call");
  click(m, "Keep this decision");
  expect(m.view.queryByText("Dismiss this decision?") === null).toBe(true);
  expect(m.frames).toEqual([]);
  click(m, /Dismiss:/);
  expect(m.view.getByRole("button", { name: "Wrong call" }).getAttribute("aria-pressed")).toBe("false");
  click(m, "Dismiss with no reason");
  expect(m.frames).toEqual([{ type: "inbox_resolve", itemId: "notice", optionId: "dismiss" }]);
  expect(m.decided).toEqual(["notice"]);
  m.view.unmount();
  const chosen = mount(); click(chosen, /Dismiss:/); click(chosen, "Need more info");
  click(chosen, "Dismiss with reason: Need more info");
  expect(chosen.frames).toEqual([{ type: "inbox_resolve", itemId: "notice", optionId: "dismiss", reason: "need_more_info" }]);
  expect(chosen.decided).toEqual(["notice"]);
});

test("dismiss can send without a reason", () => {
  const m = mount(); click(m, /Dismiss:/); click(m, "Dismiss with no reason");
  expect(m.frames).toEqual([{ type: "inbox_resolve", itemId: "notice", optionId: "dismiss" }]);
});

test("later previews, cancels without sending, then snoozes", () => {
  const m = mount(); click(m, /Later:/);
  expect(m.view.container.textContent).toContain("Later → back at the next scheduled time");
  expect(m.frames).toEqual([]);
  click(m, "Cancel snooze");
  expect(m.view.queryByText("Later → back at the next scheduled time") === null).toBe(true);
  click(m, /Later:/); click(m, "Snooze until the next scheduled time");
  expect(m.frames).toEqual([{ type: "inbox_snooze", itemId: "notice" }]);
});

test("snoozed still permits approval and dismissal but offers no later", () => {
  const m = mount(decision({ status: "snoozed", waitUntil: T + 3_600_000 }));
  expect(m.view.queryByRole("button", { name: /Later:/ }) === null).toBe(true);
  expect(m.view.container.textContent).toContain("Already snoozed until");
  expect(disabled(m, approve)).toBe(false);
  click(m, /Dismiss:/); click(m, "Keep this decision"); click(m, approve);
  expect(m.frames).toHaveLength(1);
});

test("offline locks answers but details and blocked queue navigation work", () => {
  const m = mount(); act(() => m.root.stores.inbox.setState({ online: false }));
  expect(disabled(m, approve)).toBe(true);
  expect(disabled(m, /Later:/)).toBe(true);
  expect(disabled(m, /Dismiss:/)).toBe(true);
  expect(m.view.container.textContent).toContain("needs the host");
  click(m, approve); click(m, `Details: ${TITLE}`); click(m, `Open the queue item blocked on: ${TITLE}`);
  expect(m.frames).toEqual([]); expect(m.details).toEqual(["notice"]); expect(m.queue).toEqual(["port-work"]);
});

test("compact cards open details instead of offering a commit", () => {
  const m = mount(decision(), true);
  expect(m.view.queryByRole("button", { name: approve }) === null).toBe(true);
  expect(m.view.container.textContent).toContain(PATH);
  const card = m.view.getByRole("group", { name: /^Approve\?/ });
  fireEvent.keyDown(card, { key: "a" }); fireEvent.keyDown(card, { key: "Enter" });
  expect(m.details).toEqual(["notice", "notice"]);
  fireEvent.keyDown(card, { key: "d" }); click(m, "Keep this decision");
  fireEvent.keyDown(card, { key: "s" }); click(m, "Snooze until the next scheduled time");
  expect(m.frames).toEqual([{ type: "inbox_snooze", itemId: "notice" }]);
});

test("long effects require revealing all lines before approval", () => {
  const item = decision();
  const effect = item.options[0]!.effect;
  if (effect.kind !== "enqueue" || !effect.payload.operation) throw new Error("missing effect input");
  effect.payload.operation.input = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`fee${i}`, `${i} drachmas`]));
  expect(Object.keys(effect.payload.operation.input)).toHaveLength(15);
  const m = mount(item);
  expect(m.view.queryByRole("button", { name: approve }) === null).toBe(true);
  fireEvent.keyDown(m.view.getByRole("group", { name: /^Approve\?/ }), { key: "a" });
  expect(m.frames).toEqual([]); expect(m.details).toEqual(["notice"]);
  click(m, /Review all \d+ lines before approving/);
  expect(m.view.container.textContent).toContain('"fee14": "14 drachmas"');
  click(m, approve); expect(m.frames).toHaveLength(1);
});

test("malformed effects cannot be approved", () => {
  const item = decision();
  item.options[0] = { id: "broken", label: "File it", effect: { kind: "future_effect" } } as unknown as InboxActionItem["options"][number];
  const m = mount(item);
  expect(disabled(m, "Approve (unavailable: the effect can't be shown)")).toBe(true);
  expect(m.view.container.textContent).toContain("This effect can't be displayed.");
  click(m, /Approve/); expect(m.frames).toEqual([]);
  click(m, /Dismiss:/); click(m, "Dismiss with no reason"); expect(m.frames).toHaveLength(1);
});

test("deferred effects are shown as unavailable and cannot run", () => {
  const item = decision();
  item.options[0] = { id: "session", label: "Open Ithaca session", effect: { kind: "open_session", seed: { prompt: "Review the Ithaca notice" } } };
  const m = mount(item);
  expect(disabled(m, /Open Ithaca session/)).toBe(true);
  expect(m.view.container.textContent).toContain("Not available in this version");
  expect(m.view.queryByRole("button", { name: approve }) === null).toBe(true);
  click(m, /Open Ithaca session/); expect(m.frames).toEqual([]);
});

test("a missing dismiss option disables dismissal", () => {
  const item = decision(); item.options.pop(); const m = mount(item);
  expect(disabled(m, /Dismiss:/)).toBe(true);
  expect(m.view.container.textContent).toContain("This decision has no dismiss option.");
  click(m, /Dismiss:/); expect(m.view.queryByText("Dismiss this decision?") === null).toBe(true);
});

test("changed decisions require review of the old and new effect before answering", () => {
  const before = decision(), after = decision({ version: 2, payload: { title: "File the revised Ithaca fee?", detail: "The fee is now 15 drachmas." } });
  const effect = after.options[0]!.effect;
  if (effect.kind !== "enqueue" || !effect.payload.operation) throw new Error("missing revised effect");
  effect.payload.operation.input = { path: PATH, append: "15 drachmas" };
  const m = mount(after);
  act(() => m.root.stores.inbox.setState({ changes: { notice: { before, fields: ["title", "detail", "effect", "expiry"], reviewed: false } } }));
  expect(disabled(m, approve)).toBe(true);
  expect(disabled(m, /Later:/)).toBe(true); expect(disabled(m, /Dismiss:/)).toBe(true);
  click(m, approve); expect(m.frames).toEqual([]);
  click(m, "Review changes");
  expect(m.view.container.textContent).toContain(TITLE);
  expect(m.view.container.textContent).toContain(after.payload.title);
  expect(m.view.container.textContent).toContain('"append":"12 drachmas"');
  expect(m.view.container.textContent).toContain('"append":"15 drachmas"');
  expect(disabled(m, approve)).toBe(false);
  click(m, approve); expect(m.frames).toHaveLength(1);
});

test("a revision closes an obsolete dismiss confirmation", () => {
  const m = mount(); click(m, /Dismiss:/); click(m, "Wrong call");
  m.revise(decision({ version: 2 }));
  expect(m.view.queryByText("Dismiss this decision?") === null).toBe(true);
  click(m, /Dismiss:/);
  expect(m.view.getByRole("button", { name: "Wrong call" }).getAttribute("aria-pressed")).toBe("false");
});

for (const [state, notice] of [
  ["applying", "Recording…"], ["unconfirmed", "Sent, not confirmed — reconnecting."], ["refused", "Checking what happened…"],
] as const) {
  test(`flight ${state} shows its status and locks duplicate answers`, () => {
    const m = mount();
    const flight: InFlightDecision = { kind: "commit", optionId: "file", label: "Approve", receipt: "Approved", sentVersion: 1, state };
    act(() => m.root.stores.inbox.setState({ inFlight: { notice: flight } }));
    expect(m.view.container.textContent).toContain(notice);
    for (const name of [/Recording…/, /Later:/, /Dismiss:/]) { expect(disabled(m, name)).toBe(true); click(m, name); }
    expect(m.frames).toEqual([]); click(m, `Details: ${TITLE}`); expect(m.details).toEqual(["notice"]);
  });
}

for (const [kind, notice] of [
  ["not-received", "Your Approve was not received. Nothing was applied."],
  ["not-applied", "Couldn't apply that decision. Nothing changed."],
] as const) {
  test(`failure ${kind} explains nothing applied and permits an explicit retry`, () => {
    const m = mount();
    act(() => m.root.stores.inbox.setState({ outcomes: { notice: kind === "not-received" ? { kind, label: "Approve" } : { kind } } }));
    expect(m.view.getByRole("alert").textContent).toContain(notice);
    expect(m.frames).toEqual([]); click(m, approve); expect(m.frames).toHaveLength(1);
    expect(m.view.queryByRole("alert") === null).toBe(true);
  });
}

const receipts: { name: string; outcome: InboxOutcome; text: string; queue: boolean }[] = [
  { name: "approved", outcome: { kind: "receipt", status: "resolved", by: "you", text: "Approved · queued Edit → finances/ithaca-port.md" }, text: "Approved · queued Edit → finances/ithaca-port.md", queue: true },
  { name: "dismissed", outcome: { kind: "receipt", status: "dismissed", by: "you", reason: "wrong_call" }, text: "Dismissed · reason: wrong call", queue: false },
  { name: "snoozed", outcome: { kind: "receipt", status: "snoozed", by: "you", waitUntil: T }, text: "Snoozed until", queue: false },
  { name: "elsewhere", outcome: { kind: "receipt", status: "resolved", by: "elsewhere" }, text: `Resolved on another device · ${TITLE}`, queue: true },
  { name: "unknown", outcome: { kind: "receipt", status: "resolved", by: "unknown" }, text: "Resolved", queue: true },
  { name: "lost", outcome: { kind: "receipt", status: "resolved", by: "elsewhere", lost: "Dismiss" }, text: "Already resolved on another device. Your Dismiss was not applied.", queue: false },
  { name: "reconnected", outcome: { kind: "receipt", status: "resolved", by: "you", afterReconnect: true }, text: "Resolved · confirmed after reconnect", queue: true },
  { name: "dropped", outcome: { kind: "gone", status: "dropped" }, text: `Dropped at the cap (60) · ${TITLE}`, queue: false },
  { name: "expired", outcome: { kind: "gone", status: "expired" }, text: `Expired · ${TITLE}`, queue: false },
  { name: "removed", outcome: { kind: "gone", status: "removed" }, text: `No longer listed · ${TITLE}`, queue: false },
];
for (const receipt of receipts) {
  test(`receipt ${receipt.name} reports the outcome and only offers applicable queue navigation`, () => {
    const queued: string[] = [];
    const view = render(<OutcomeRow item={decision()} outcome={receipt.outcome} onQueue={() => queued.push("queue")} />);
    expect(view.getByRole("status").textContent).toContain(receipt.text);
    expect(view.queryByRole("button", { name: "Queue ▸" }) !== null).toBe(receipt.queue);
    expect(view.queryByRole("button", { name: approve }) === null).toBe(true);
    if (receipt.queue) { fireEvent.click(view.getByRole("button", { name: "Queue ▸" })); expect(queued).toEqual(["queue"]); }
  });
}

for (const [status, text] of [
  ["resolved", "This decision is resolved."], ["dismissed", "This decision is dismissed."],
  ["dropped", "Dropped at the cap (60) · lower priority than every open decision"], ["expired", "Expired · no longer answerable"],
  [undefined, "This decision is no longer listed."],
] as const) {
  test(`closed detail ${status ?? "missing"} has a status and back action without answer controls`, () => {
    const m = mount(); m.view.unmount();
    const back: string[] = [];
    const view = render(<BrainUiProvider root={m.root}><DecisionDetail item={status ? decision({ status }) : undefined}
      context={context} why="stakes 1 · no deadline" onBack={() => back.push("back")} onQueue={() => {}} /></BrainUiProvider>);
    expect(view.getByRole("status").textContent).toBe(text);
    expect(view.queryByRole("button", { name: approve }) === null).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Back to Actions" })); expect(back).toEqual(["back"]);
  });
}

test("open detail expands a compact decision and discloses the thread notes", () => {
  const m = mount(); m.view.unmount();
  const view = render(<BrainUiProvider root={m.root}><DecisionDetail item={decision()} context={{ ...context, compact: true }}
    why="stakes 1 · no deadline" onBack={() => {}} onQueue={() => {}} /></BrainUiProvider>);
  expect(view.queryByRole("button", { name: approve })).not.toBeNull();
  expect(view.container.textContent).toContain("stakes 1 · no deadline");
  fireEvent.click(view.getByRole("button", { name: /Agent's notes/ }));
  expect(view.container.textContent).toContain(thread.stateMd);
});

test("FYI notes and thread headers present provenance without decision controls", () => {
  const view = render(<><NoteCard item={decision({ type: "fyi" })} /><ThreadHeader thread={thread} count={2} /></>);
  expect(view.container.textContent).toContain("Penelope forwarded the port fee.");
  expect(view.container.textContent).toContain("▸ Ithaca harbour · untrusted · share · 2");
  expect(view.queryByRole("button") === null).toBe(true);
});
