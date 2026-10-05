// Send bug report for failed activities (#598), rendered in happy-dom against
// the real ActivityPage. Only the transports are fixtures: `fetch` answers
// from Odysseus data and records every request, and `window.open` and the
// clipboard are stubs whose arguments are the outgoing report. No test opens
// a real URL or creates an issue. Queries come from `render()`, never
// `screen` — see tests/render/dom.ts for why.
import { unregisterActivityReportDom } from "./activity-report-dom.js";

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ActivityRunDetail, ActivityRunSummary, ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";

import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { useActivityStore } from "../../src/stores/activity-store.js";
import { useChatStore } from "../../src/stores/chat-store.js";
import { useConnectionStore } from "../../src/stores/connection-store.js";
import { useUIStore } from "../../src/stores/ui-store.js";

afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  unregisterActivityReportDom();
});

const SECRET = "sk-odyssey-0000000000000000";
const PATH = "/home/penelope/loom/ledger.md";
const HOST = "ithaca-harbour.example";
const T0 = Date.parse("2026-07-12T06:00:00Z");

function summary(over: Partial<ActivityRunSummary> & Pick<ActivityRunSummary, "runId">): ActivityRunSummary {
  return {
    origin: "cron", name: "cron", sessionId: null, jobName: null, startedAt: T0, endedAt: T0 + 9000,
    outcome: "success", running: false, durationMs: 9000, costUsd: 0, effectiveCostUsd: 0, billingMode: "subscription",
    failureReason: null, detailPruned: false, ...over,
  };
}

const HISTORY: ActivityRunSummary[] = [
  summary({ runId: "run-harbour", jobName: "Penelope loom ledger", outcome: "timeout", durationMs: 242_000,
    failureReason: `Bash timed out reading ${PATH} on ${HOST} with token=${SECRET}` }),
  summary({ runId: "run-loom", origin: "session", name: "Ask about the loom order", sessionId: "session-telemachus", outcome: "error" }),
  summary({ runId: "run-digest", jobName: "Weekly digest", outcome: "success" }),
  summary({ runId: "run-cancel", jobName: "Suitor count", outcome: "cancelled" }),
  summary({ runId: "run-denied", jobName: "Raft repair", outcome: "denied" }),
  summary({ runId: "run-storm", jobName: "Storm watch", outcome: "interrupted", detailPruned: true }),
];

function span(over: Partial<ActivitySpan> & Pick<ActivitySpan, "spanId" | "runId">): ActivitySpan {
  return { name: "cron:job", kind: "cron", origin: "cron", startedAt: T0, ...over } as ActivitySpan;
}

const HARBOUR_SPANS: ActivitySpan[] = [
  span({ spanId: "h-root", runId: "run-harbour", outcome: "timeout", endedAt: T0 + 242_000 }),
  span({ spanId: "h-1", runId: "run-harbour", parentSpanId: "h-root", kind: "tool", toolName: "Read", name: `Read ${PATH}`, outcome: "success" }),
  span({ spanId: "h-2", runId: "run-harbour", parentSpanId: "h-root", kind: "tool", toolName: "Bash", name: "Bash", outcome: "timeout" }),
];

type Call = { url: string; method: string };
let calls: Call[] = [];
let opened: string[] = [];
let clipboard: string[] = [];
let clipboardFails = false;
let detailGate: Promise<void> | null = null;
let statusOk = true;
let liveRuns: ActivityRunSummary[] = [];
const realFetch = globalThis.fetch;
const realOpen = window.open;

beforeEach(() => {
  calls = []; opened = []; clipboard = []; clipboardFails = false; detailGate = null; statusOk = true; liveRuns = [];
  useActivityStore.setState({ spans: {}, events: {}, highWater: {}, deltaSeq: {}, spanRun: {}, inbox: [] });
  useChatStore.setState({ activeSessionId: null });
  useUIStore.setState({ activeView: "activity" });
  useConnectionStore.setState({ wsStatus: "connected" });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.includes("/activity/runs?")) return Response.json({ live: liveRuns, history: HISTORY });
    const detail = /\/activity\/runs\/([^?]+)/.exec(url);
    if (detail) {
      if (detailGate) await detailGate;
      const runId = decodeURIComponent(detail[1]!);
      if (runId === "run-harbour") return Response.json({ runId, detailPruned: false, spans: HARBOUR_SPANS, events: [], highWaterSeq: 1,
        rollup: { ...HISTORY[0]!, spanCount: 3 } } satisfies ActivityRunDetail);
      if (runId === "run-loom") return Response.json({ runId, detailPruned: false, spans: [], events: [] });
      if (runId === "run-sirens") return Response.json({ runId, detailPruned: false, spans: [], events: [],
        rollup: { ...summary({ runId, jobName: "Siren watch", outcome: "error" }), spanCount: 1, failureReason: `Siren song read ${PATH}` } });
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (url.includes("/activity/rollups")) return Response.json({ timeZone: "UTC", days: [] });
    if (url.includes("/models/pricing")) return Response.json({ stale: false, error: null });
    if (url.includes("/activity/inbox")) return Response.json({ intents: [] });
    if (url.endsWith("/status")) {
      return statusOk
        ? Response.json({ healthy: true, uptime: 1, version: "a1b2c3d", software: { release: "0.41.2", sourceCommit: "a1b2c3d" }, cronJobs: [], activeSession: false })
        : Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;
  window.open = ((url: string) => { opened.push(url); return null; }) as typeof window.open;
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => { if (clipboardFails) throw new Error("denied"); clipboard.push(text); } },
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  window.open = realOpen;
});

async function mount() {
  const page = render(<ActivityPage />);
  await page.findByText("History", undefined, { timeout: 5000 });
  return page;
}

const reportButtons = (page: ReturnType<typeof render>) =>
  [...page.container.querySelectorAll<HTMLButtonElement>("button[data-report-run]")];
const dialog = () => document.body.querySelector<HTMLDialogElement>("dialog.turn-diagnostic-dialog");
const field = (label: string) => {
  const d = dialog()!;
  const node = [...d.querySelectorAll("label")].find((l) => l.textContent === label)!;
  return d.querySelector<HTMLInputElement & HTMLTextAreaElement>(`#${CSS.escape(node.htmlFor)}`)!;
};
const buttonIn = (root: ParentNode, name: string | RegExp) =>
  [...root.querySelectorAll<HTMLElement>("[role=button], button")].find((b) =>
    typeof name === "string" ? b.textContent?.trim().startsWith(name) : name.test(b.textContent ?? ""))!;

/**
 * Type into a field as a user does. react-dom loads before happy-dom here and
 * takes its input-event polyfill (see tests/render/dom.ts), which reads a
 * change through the focused field's key events.
 */
function type(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  node.focus();
  fireEvent.input(node, { target: { value } });
  fireEvent.keyUp(node);
}

/** The detail pane's button, apart from the queue's row siblings. */
const detailButton = (page: ReturnType<typeof render>) =>
  [...page.container.querySelectorAll<HTMLButtonElement>("button[data-report-run]")]
    .find((b) => !b.closest('section[aria-label="Actions queue"]')) ?? null;

async function openReport(page: ReturnType<typeof render>, runId: string) {
  const button = reportButtons(page).find((b) => b.dataset.reportRun === runId)!;
  button.focus();
  fireEvent.click(button);
  await waitFor(() => expect(dialog()).toBeTruthy());
  return button;
}

describe("eligibility", () => {
  test("only failed runs offer Send bug report, by the shared predicate", async () => {
    const page = await mount();
    expect(reportButtons(page).map((b) => b.dataset.reportRun).sort()).toEqual(["run-harbour", "run-loom", "run-storm"]);
  });

  test("the accessible name is the full form; the visible text narrows below 480px", async () => {
    const page = await mount();
    const harbour = reportButtons(page).find((b) => b.dataset.reportRun === "run-harbour")!;
    expect(harbour.getAttribute("aria-label")).toMatch(/^Send bug report: Penelope loom ledger, timeout, .+/);
    const spans = [...harbour.querySelectorAll("span")];
    expect(spans.map((s) => [s.textContent, s.className])).toEqual([
      ["Report", "tablet:hidden"],
      ["Send bug report", "hidden tablet:inline"],
    ]);
  });

  test("no interactive control is nested in another", async () => {
    const page = await mount();
    const failed = [...page.container.querySelectorAll("[data-failed-run]")];
    expect(failed).toHaveLength(3);
    for (const row of failed) {
      expect(row.querySelectorAll("button button, button [role=button], [role=button] button, [role=button] [role=button]")).toHaveLength(0);
      expect(row.querySelectorAll("[role=button], button")).toHaveLength(2);
    }
  });

  test("a run this page watched end as failed offers the action without a reload", async () => {
    const live = span({ spanId: "live-root", runId: "run-sirens", name: "cron:Siren watch", jobName: "Siren watch", startedAt: Date.now() - 4000 });
    useActivityStore.getState().applySnapshot({ type: "activity_snapshot", view: "index", spans: [live], events: [], highWaterSeq: { "run-sirens": 1 } });
    const page = render(<ActivityPage />);
    await page.findByText("Running now", undefined, { timeout: 5000 });
    const runsFetched = calls.filter((c) => c.url.includes("/activity/runs?")).length;
    act(() => {
      useActivityStore.getState().applyDelta({ type: "activity_delta", runId: "run-sirens", seq: 2,
        span: { ...live, outcome: "error", endedAt: Date.now() } });
    });
    fireEvent.click([...page.container.querySelectorAll<HTMLElement>("[role=tab]")].find((t) => (t.textContent ?? "").startsWith("done"))!);
    await waitFor(() => expect(reportButtons(page).map((b) => b.dataset.reportRun)).toContain("run-sirens"));
    expect(calls.filter((c) => c.url.includes("/activity/runs?")).length).toBe(runsFetched);
    // The bounded mirror may evict the finished run before a refresh lists it.
    act(() => { useActivityStore.setState({ spans: {}, events: {} }); });
    expect(reportButtons(page).map((b) => b.dataset.reportRun)).toContain("run-sirens");
    // The promoted row has no reason or billing of its own; the record's rollup does.
    await openReport(page, "run-sirens");
    await waitFor(() => expect(field("Exact outgoing text").value).toContain("\nbilling: subscription"));
    await waitFor(() => expect(buttonIn(dialog()!, "+ Add failure reason for review")).toBeTruthy());
    fireEvent.click(buttonIn(dialog()!, "+ Add failure reason for review"));
    expect(field("Exact outgoing text").value).toContain("Failure reason (review before sharing):\nSiren song read [redacted path]");
  });
});

describe("history order", () => {
  test("once REST history lists a promoted run it is forgotten, and never resurrected", async () => {
    const live = span({ spanId: "z-root", runId: "run-zephyr", name: "cron:Zephyr", jobName: "Wind bag audit", startedAt: Date.now() - 4000 });
    useActivityStore.getState().applySnapshot({ type: "activity_snapshot", view: "index", spans: [live], events: [], highWaterSeq: { "run-zephyr": 1 } });
    const page = render(<ActivityPage />);
    await page.findByText("Running now", undefined, { timeout: 5000 });
    act(() => {
      useActivityStore.getState().applyDelta({ type: "activity_delta", runId: "run-zephyr", seq: 2, span: { ...live, outcome: "error", endedAt: Date.now() } });
    });
    fireEvent.click([...page.container.querySelectorAll<HTMLElement>("[role=tab]")].find((t) => (t.textContent ?? "").startsWith("done"))!);
    await waitFor(() => expect(reportButtons(page).map((b) => b.dataset.reportRun)).toContain("run-zephyr"));
    HISTORY.unshift(summary({ runId: "run-zephyr", jobName: "Wind bag audit", outcome: "error", startedAt: live.startedAt }));
    try {
      fireEvent.click(page.getByRole("button", { name: "Refresh" }));
      await waitFor(() => expect(calls.filter((c) => c.url.includes("/activity/runs?")).length).toBe(2));
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(reportButtons(page).filter((b) => b.dataset.reportRun === "run-zephyr")).toHaveLength(1);
    } finally { HISTORY.shift(); }
    // The run has left the REST window; the page must not bring its old copy back.
    fireEvent.click(page.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls.filter((c) => c.url.includes("/activity/runs?")).length).toBe(3));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(reportButtons(page).map((b) => b.dataset.reportRun)).not.toContain("run-zephyr");
  });

  test("a promoted run takes its place by start time, not the top", async () => {
    const older = span({ spanId: "o-root", runId: "run-older", name: "cron:Lotus census", jobName: "Lotus census", startedAt: T0 - 3_600_000 });
    useActivityStore.getState().applySnapshot({ type: "activity_snapshot", view: "index", spans: [older], events: [], highWaterSeq: { "run-older": 1 } });
    const page = render(<ActivityPage />);
    await page.findByText("Running now", undefined, { timeout: 5000 });
    act(() => {
      useActivityStore.getState().applyDelta({ type: "activity_delta", runId: "run-older", seq: 2, span: { ...older, outcome: "error", endedAt: T0 + 60_000 } });
    });
    fireEvent.click([...page.container.querySelectorAll<HTMLElement>("[role=tab]")].find((t) => (t.textContent ?? "").startsWith("done"))!);
    await waitFor(() => expect(reportButtons(page).map((b) => b.dataset.reportRun)).toContain("run-older"));
    expect(reportButtons(page).map((b) => b.dataset.reportRun)).toEqual(["run-harbour", "run-loom", "run-storm", "run-older"]);
  });
});

describe("opening never navigates or sends", () => {
  test("the session row's sibling opens the review, not Chat; the row itself still opens Chat", async () => {
    const page = await mount();
    await openReport(page, "run-loom");
    expect(useUIStore.getState().activeView).toBe("activity");
    expect(useChatStore.getState().activeSessionId).toBeNull();
    fireEvent.click(buttonIn(dialog()!, "Close review"));
    await waitFor(() => expect(dialog()).toBeNull());
    fireEvent.click(page.getByText("Ask about the loom order").closest("[role=button]")!);
    expect(useUIStore.getState().activeView).toBe("chat");
    expect(useChatStore.getState().activeSessionId).toBe("session-telemachus");
  });

  test("open and close make one same-origin read of the run, without payloads, and nothing else", async () => {
    const page = await mount();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/status"))).toBe(true));
    const before = calls.length;
    await openReport(page, "run-harbour");
    await waitFor(() => expect(field("Exact outgoing text").value).toContain("failed steps: Bash"));
    fireEvent.click(buttonIn(dialog()!, "Close review"));
    await waitFor(() => expect(dialog()).toBeNull());
    const during = calls.slice(before);
    expect(during).toEqual([{ url: expect.stringMatching(/\/activity\/runs\/run-harbour$/), method: "GET" }]);
    expect(during.every((c) => !/^https?:/.test(c.url) || new URL(c.url).origin === window.location.origin)).toBe(true);
    expect(opened).toEqual([]);
    expect(clipboard).toEqual([]);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("a pruned run reads nothing more and says rollup only", async () => {
    const page = await mount();
    const before = calls.length;
    await openReport(page, "run-storm");
    const body = field("Exact outgoing text").value;
    expect(body).toContain("record: rollup only (detail pruned)");
    expect(body).not.toContain("failed steps");
    expect(calls.slice(before)).toEqual([]);
  });
});

describe("the outgoing draft is exactly the reviewed text", () => {
  test("defaults omit failure text, job name and IDs; edits and removals reach the URL and the clipboard verbatim", async () => {
    const page = await mount();
    await openReport(page, "run-harbour");
    await waitFor(() => expect(field("Exact outgoing text").value).toContain("failed steps: Bash"));
    const generated = field("Exact outgoing text").value + field("Title").value;
    for (const leak of [SECRET, PATH, HOST, "Penelope", "run-harbour", "h-root"]) expect(generated).not.toContain(leak);
    expect(generated).toContain("server: 0.41.2");
    expect(generated).toContain("server commit: a1b2c3d");

    const title = "Harbour sync times out on Ithaca";
    const body = field("Exact outgoing text").value.replace("billing: subscription\n", "").replace(/billing: subscription$/, "")
      .replace("## Expected\n", "## Expected\nThe ledger syncs.\n");
    type(field("Title"), title);
    type(field("Exact outgoing text"), body);
    fireEvent.click(buttonIn(dialog()!, "Open issue on GitHub"));
    expect(opened).toHaveLength(1);
    const url = new URL(opened[0]!);
    expect(url.origin + url.pathname).toBe("https://github.com/schlessera/brain-kit/issues/new");
    expect(url.searchParams.get("title")).toBe(title);
    expect(url.searchParams.get("body")).toBe(body);
    expect(body).not.toContain("billing:");
    expect(dialog()!.querySelector("[role=status]")!.textContent).toBe(
      "GitHub's new-issue form was opened with this text in a new tab. The issue isn't filed until you submit it on GitHub. If no tab opened, copy the text and paste it into a new issue.");

    fireEvent.click(buttonIn(dialog()!, "Copy"));
    await waitFor(() => expect(clipboard).toEqual([`${title}\n\n${body}`]));
  });

  test("the failure reason and job name arrive only by their buttons, redacted and labelled", async () => {
    const page = await mount();
    await openReport(page, "run-harbour");
    fireEvent.click(buttonIn(dialog()!, "+ Add failure reason for review"));
    fireEvent.click(buttonIn(dialog()!, "+ Add job name for review"));
    const body = field("Exact outgoing text").value;
    expect(body).toContain("Failure reason (review before sharing):\nBash timed out reading [redacted path]");
    expect(body).not.toContain(SECRET);
    expect(body).toContain("job: Penelope loom ledger");
  });

  test("an oversized report is refused, nothing is truncated, and copy still works", async () => {
    const page = await mount();
    await openReport(page, "run-harbour");
    const big = "Charybdis ".repeat(900);
    type(field("Exact outgoing text"), big);
    fireEvent.click(buttonIn(dialog()!, "Open issue on GitHub"));
    expect(opened).toEqual([]);
    expect(field("Exact outgoing text").value).toBe(big);
    expect(dialog()!.querySelector("[data-report-meter]")!.textContent).toMatch(/^Too long for the issue link by [\d,]+ — copy instead, or shorten it$/);
    expect(dialog()!.querySelector("[role=status]")!.textContent).toBe(
      "This report is too long for the issue link. Copy it and paste it into a new issue on GitHub, or shorten it.");
  });

  test("an oversized link right after a draft still explains the refusal", async () => {
    const page = await mount();
    await openReport(page, "run-harbour");
    fireEvent.click(buttonIn(dialog()!, "Open issue on GitHub"));
    type(field("Exact outgoing text"), "Charybdis ".repeat(900));
    fireEvent.click(buttonIn(dialog()!, "Open issue on GitHub"));
    expect(opened).toHaveLength(1);
    expect(dialog()!.querySelector("[role=status]")!.textContent).toBe(
      "This report is too long for the issue link. Copy it and paste it into a new issue on GitHub, or shorten it.");
  });

  test("a refused clipboard selects the text and says so", async () => {
    clipboardFails = true;
    const page = await mount();
    await openReport(page, "run-harbour");
    await waitFor(() => expect(field("Exact outgoing text").value).toContain("failed steps: Bash"));
    fireEvent.click(buttonIn(dialog()!, "Copy"));
    await waitFor(() => expect(dialog()!.querySelector("[role=status]")!.textContent).toBe("Couldn't copy. The text is selected; copy it manually."));
    const body = field("Exact outgoing text");
    expect([body.selectionStart, body.selectionEnd]).toEqual([0, body.value.length]);
  });

  test("a double tap opens one draft; a deliberate second tap opens another", async () => {
    const page = await mount();
    await openReport(page, "run-harbour");
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      fireEvent.click(buttonIn(dialog()!, "Open issue on GitHub"));
      now += 200;
      fireEvent.click(buttonIn(dialog()!, "Open issue on GitHub"));
      expect(opened).toHaveLength(1);
      now += 1100;
      expect(buttonIn(dialog()!, "Open issue on GitHub").textContent).toContain("Open issue on GitHub again");
      fireEvent.click(buttonIn(dialog()!, "Open issue on GitHub"));
      expect(opened).toHaveLength(2);
    } finally { Date.now = realNow; }
  });
});

describe("late, limited and offline records", () => {
  test("an untouched body gains the fetched steps; an edited one keeps the edits and offers them", async () => {
    let release!: () => void;
    detailGate = new Promise((resolve) => { release = resolve; });
    const page = await mount();
    await openReport(page, "run-harbour");
    expect(field("Exact outgoing text").value).not.toContain("failed steps");
    const edited = `${field("Exact outgoing text").value}\nmy note`;
    type(field("Exact outgoing text"), edited);
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    await waitFor(() => expect(dialog()!.querySelector("[role=status]")!.textContent).toContain("Step details loaded."));
    expect(field("Exact outgoing text").value).toBe(edited);
    fireEvent.click(buttonIn(dialog()!, "+ Add step summary"));
    expect(field("Exact outgoing text").value).toBe(`${edited}\n\nrecord: retained · 3 steps\nfailed steps: Bash`);
  });

  test("a run the server no longer has says not found", async () => {
    const page = await mount();
    await openReport(page, "run-loom");
    // run-loom answers retained; use a row whose record is gone.
    fireEvent.click(buttonIn(dialog()!, "Close review"));
    HISTORY.push(summary({ runId: "run-gone", jobName: "Cyclops census", outcome: "error" }));
    try {
      cleanup();
      const again = await mount();
      await openReport(again, "run-gone");
      await waitFor(() => expect(field("Exact outgoing text").value).toContain("record: not found"));
      expect(field("Exact outgoing text").value).not.toContain("failed steps");
    } finally { HISTORY.pop(); }
  });

  test("offline: steps not loaded, the offline note, and Open still enabled", async () => {
    const page = await mount();
    useConnectionStore.setState({ wsStatus: "disconnected" });
    globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await openReport(page, "run-harbour");
    await waitFor(() => expect(field("Exact outgoing text").value).toContain("failed steps: not loaded (offline)"));
    expect(dialog()!.textContent).toContain("You appear to be offline. Copy works now; the GitHub link needs a connection.");
    fireEvent.click(buttonIn(dialog()!, "Open issue on GitHub"));
    expect(opened).toHaveLength(1);
  });

  test("status not authorized: no server line", async () => {
    statusOk = false;
    const page = await mount();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/status"))).toBe(true));
    await openReport(page, "run-storm");
    expect(field("Exact outgoing text").value).not.toMatch(/^server/m);
  });
});

describe("focus", () => {
  test("when the lens changes under the sheet, focus lands on the Actions heading", async () => {
    const page = await mount();
    await openReport(page, "run-harbour");
    const live = span({ spanId: "n-root", runId: "run-nausicaa", name: "cron:Nausicaa", jobName: "Laundry", startedAt: Date.now() });
    act(() => {
      useActivityStore.getState().applySnapshot({ type: "activity_snapshot", view: "index", spans: [live], events: [], highWaterSeq: { "run-nausicaa": 1 } });
    });
    await waitFor(() => expect(page.container.querySelector("[data-history-heading]")).toBeNull());
    expect(reportButtons(page)).toHaveLength(0);
    fireEvent(dialog()!, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(page.container.querySelector("[data-activity-heading]"));
  });

  test("Escape closes and returns focus to the opener", async () => {
    const page = await mount();
    const opener = await openReport(page, "run-harbour");
    expect(document.activeElement?.tagName).toBe("H2");
    fireEvent(dialog()!, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});

describe("run detail", () => {
  test("a failure seen before the detail read settles does not freeze a partial record", async () => {
    let release!: () => void;
    detailGate = new Promise((resolve) => { release = resolve; });
    const root = { ...HARBOUR_SPANS[0]!, outcome: undefined, endedAt: undefined };
    useActivityStore.getState().applySnapshot({ type: "activity_snapshot", view: "index", spans: [root], events: [], highWaterSeq: { "run-harbour": 1 } });
    window.location.hash = "#/activity/run-harbour";
    try {
      const page = render(<ActivityPage />);
      await waitFor(() => expect(page.container.querySelector("[data-run-detail-heading]")).toBeTruthy(), { timeout: 5000 });
      act(() => {
        useActivityStore.getState().applyDelta({ type: "activity_delta", runId: "run-harbour", seq: 2, span: { ...HARBOUR_SPANS[0]! } });
      });
      await waitFor(() => expect(detailButton(page)).toBeTruthy());
      fireEvent.click(detailButton(page)!);
      await waitFor(() => expect(dialog()).toBeTruthy());
      expect(field("Exact outgoing text").value).not.toContain("record: retained");
      await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
      await waitFor(() => expect(field("Exact outgoing text").value).toContain("record: retained · 3 steps\nfailed steps: Bash"));
    } finally { window.location.hash = ""; }
  });

  test("a failed cron run's detail offers the button under the receipt, with its record", async () => {
    window.location.hash = "#/activity/run-harbour";
    try {
      const page = render(<ActivityPage />);
      await waitFor(() => expect(detailButton(page)).toBeTruthy(), { timeout: 5000 });
      const button = detailButton(page)!;
      expect(button.getAttribute("aria-label")).toMatch(/^Send bug report: Penelope loom ledger, timeout, /);
      expect(button.textContent).toBe("Send bug report");
      expect(page.container.textContent).toContain("Opens a review first. Nothing is sent until you choose to.");
      fireEvent.click(button);
      await waitFor(() => expect(dialog()).toBeTruthy());
      await waitFor(() => expect(field("Exact outgoing text").value).toContain("record: retained · 3 steps\nfailed steps: Bash"));
    } finally { window.location.hash = ""; }
  });

  test("a run that ends while the detail read is in flight still reports its full record", async () => {
    let release!: () => void;
    detailGate = new Promise((resolve) => { release = resolve; });
    const root = { ...HARBOUR_SPANS[0]!, outcome: undefined, endedAt: undefined };
    useActivityStore.getState().applySnapshot({ type: "activity_snapshot", view: "index", spans: [root], events: [], highWaterSeq: { "run-harbour": 1 } });
    window.location.hash = "#/activity/run-harbour";
    try {
      const page = render(<ActivityPage />);
      await waitFor(() => expect(page.container.querySelector("[data-run-detail-heading]")).toBeTruthy(), { timeout: 5000 });
      act(() => {
        useActivityStore.getState().applyDelta({ type: "activity_delta", runId: "run-harbour", seq: 2, span: { ...HARBOUR_SPANS[0]! } });
      });
      // The detail's own snapshot (seq 1) is now older than the mirror and is refused.
      await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
      detailGate = null;
      await waitFor(() => expect(detailButton(page)).toBeTruthy());
      expect(Object.keys(useActivityStore.getState().spans["run-harbour"] ?? {})).toEqual(["h-root"]);
      fireEvent.click(detailButton(page)!);
      await waitFor(() => expect(dialog()).toBeTruthy());
      await waitFor(() => expect(field("Exact outgoing text").value).toContain("record: retained · 3 steps\nfailed steps: Bash"));
    } finally { window.location.hash = ""; }
  });

  test("a run already running on first render announces its failure, even mid-read", async () => {
    detailGate = new Promise(() => {});
    const live = span({ spanId: "e-root", runId: "run-eumaeus", name: "cron:Eumaeus", jobName: "Eumaeus pig count", startedAt: Date.now() - 1000 });
    useActivityStore.getState().applySnapshot({ type: "activity_snapshot", view: "index", spans: [live], events: [], highWaterSeq: { "run-eumaeus": 1 } });
    window.location.hash = "#/activity/run-eumaeus";
    try {
      const page = render(<ActivityPage />);
      // No await: the failure lands before any other render can re-observe "running".
      expect(page.container.querySelector("[data-run-detail-heading]")).toBeTruthy();
      act(() => {
        useActivityStore.getState().applyDelta({ type: "activity_delta", runId: "run-eumaeus", seq: 2, span: { ...live, outcome: "error", endedAt: Date.now() } });
      });
      await waitFor(() => expect(detailButton(page)).toBeTruthy());
      const statuses = [...page.container.querySelectorAll("[role=status]")].map((s) => s.textContent);
      expect(statuses.filter((s) => s === "Run failed. Send bug report is available.")).toHaveLength(1);
    } finally { window.location.hash = ""; detailGate = null; }
  });

  test("a run that fails while its detail is open gains the button and one announcement", async () => {
    const live = span({ spanId: "c-root", runId: "run-circe", name: "cron:Circe", jobName: "Circe audit", startedAt: Date.now() - 1000 });
    useActivityStore.getState().applySnapshot({ type: "activity_snapshot", view: "run", runId: "run-circe", spans: [live], events: [], highWaterSeq: { "run-circe": 1 } });
    window.location.hash = "#/activity/run-circe";
    try {
      const page = render(<ActivityPage />);
      await waitFor(() => expect(page.container.querySelector("[data-run-detail-heading]")).toBeTruthy(), { timeout: 5000 });
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      expect(detailButton(page)).toBeNull();
      act(() => {
        useActivityStore.getState().applyDelta({ type: "activity_delta", runId: "run-circe", seq: 2, span: { ...live, outcome: "interrupted", endedAt: Date.now() } });
      });
      await waitFor(() => expect(detailButton(page)?.getAttribute("aria-label")).toMatch(/^Send bug report: .+, interrupted, /));
      const statuses = [...page.container.querySelectorAll("[role=status]")].map((s) => s.textContent);
      expect(statuses.filter((s) => s === "Run failed. Send bug report is available.")).toHaveLength(1);
    } finally { window.location.hash = ""; }
  });
});
