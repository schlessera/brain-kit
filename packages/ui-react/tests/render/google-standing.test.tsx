// Standing Gmail permissions wired to the owner-only routes (#4212): the
// Settings container for `GoogleApprovalList` and the restricted chat's
// container for `GoogleAllowanceList`. Same containment contract as
// render-smoke.test.tsx: the DOM module first, `afterAll(unregister)`,
// queries off `render()` and never `screen`. The double is the root's
// `request`, the one transport every API call goes through. Every test
// asserts its whole request log (method, path and body, in order), and
// `afterEach` holds every request to its route's shape.
import { registerGoogleStandingDom, unregisterGoogleStandingDom } from "./google-standing-dom.js";

registerGoogleStandingDom();

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { GMAIL_TOOL_NAMES, GOOGLE_SESSION_ALLOWANCE_LIMITS } from "@schlessera/brain-common/internal/google-operations";
import type { SafetyHistoryProjection } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { GoogleApprovalsSection } from "../../src/components/settings/google-approvals.js";
import { SessionSafety } from "../../src/components/chat/safety-indicator.js";
import type { ChatMessage } from "../../src/stores/chat-state.js";
import {
  GOOGLE_ALLOWANCE_ITEMS, GOOGLE_ALLOWANCE_WRITE_TOOLS, allowanceGrants, approvalAccounts, completedAllowanceWrites, sinceTime, standingAction, untilTime,
} from "../../src/lib/google-standing.js";

const ODYSSEUS = "odysseus@example.com";
const PENELOPE = "penelope@example.com";
// Local times, so the host's formatting reads the same in any zone.
const NOW = new Date(2026, 6, 12, 9, 41).getTime();
const WED_8 = new Date(2026, 6, 8, 19, 22).getTime();
const THU_9 = new Date(2026, 6, 9, 8, 5).getTime();
const FRI_10 = new Date(2026, 6, 10, 17, 40).getTime();
const SAT_11 = new Date(2026, 6, 11, 9, 14).getTime();
const UNTIL_1802 = new Date(2026, 6, 12, 18, 2).getTime();
const UNTIL_2140 = new Date(2026, 6, 12, 21, 40).getTime();

interface Sent {
  url: string; path: string; method: string; type: string | null; body: unknown;
  answer(body: unknown, status?: number): Promise<void>;
  answerRaw(text: string, status: number, type: string): Promise<void>;
  fail(error: Error): Promise<void>;
}
const roots: BrainUiRoot[] = [];
let sent: Sent[] = [];
let clock: ReturnType<typeof spyOn> | undefined;

beforeEach(() => { clock = spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(async () => {
  // Every request had its route's shape: a read is a bare GET, a revoke a JSON POST of `{ id }`.
  for (const request of sent) {
    if (request.method === "GET") expect({ type: request.type, body: request.body }, `GET ${request.path}`).toEqual({ type: null, body: undefined });
    else expect({ method: request.method, type: request.type, revoke: request.path.endsWith("/revoke"), keys: Object.keys(request.body as object) }, `${request.method} ${request.path}`)
      .toEqual({ method: "POST", type: "application/json", revoke: true, keys: ["id"] });
  }
  await act(async () => { cleanup(); for (const root of roots.splice(0)) root.dispose(); });
  clock?.mockRestore();
  sent = [];
});
afterAll(async () => { await unregisterGoogleStandingDom(); });

/** A root whose every request waits for the test to answer it. */
function host(setup?: (root: BrainUiRoot) => void) {
  const root = createBrainUiRoot({
    storage: null,
    request: (url, init) => new Promise<Response>((resolve, reject) => {
      const settle = async (work: () => void) => { await act(async () => { work(); await new Promise(done => setTimeout(done, 0)); }); };
      sent.push({
        url: String(url),
        path: new URL(String(url), "http://localhost/").pathname,
        method: init?.method ?? "GET",
        type: new Headers(init?.headers).get("content-type"),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        answer: (body, status = 200) => settle(() => resolve(Response.json(body, { status }))),
        answerRaw: (text, status, type) => settle(() => resolve(new Response(text, { status, headers: { "content-type": type } }))),
        fail: error => settle(() => reject(error)),
      });
    }),
  });
  roots.push(root);
  setup?.(root);
  return root;
}

const requests = (path: string) => sent.filter(request => request.path === path);
const last = (path: string) => { const list = requests(path); expect(list.length, `a request to ${path}`).toBeGreaterThan(0); return list[list.length - 1]!; };
/** The whole request log: a read as [GET, path], a revoke as [POST, path, body]. */
const log = () => sent.map(request => (request.method === "GET" ? [request.method, request.path] : [request.method, request.path, request.body]));
const busyMarks = (scope: HTMLElement) => scope.querySelectorAll("[aria-busy]").length;

/* ── Settings › Security: remembered approvals ─────────────────────────── */

const APPROVALS_PATH = "/api/google/approvals";
const REVOKE_APPROVAL_PATH = "/api/google/approvals/revoke";
const READ_APPROVALS = ["GET", APPROVALS_PATH];
const revokeApproval = (id: string) => ["POST", REVOKE_APPROVAL_PATH, { id }];

const approval = (id: string, account: string, operation: string, entity: string, approved_at: number) =>
  ({ id, principal_id: "owner-odysseus", brain_id: "brain-ithaca", account_identity: account, operation, entity, approved_at });
// The route's order: oldest first.
const APPROVALS = [
  approval("appr-drafts", ODYSSEUS, "gmail.draft.save", "drafts", THU_9),
  approval("appr-suitors", PENELOPE, "gmail.modify", "unlabel:Label_7", THU_9),
  approval("appr-voyage", ODYSSEUS, "gmail.modify", "label:Label_12", FRI_10),
  approval("appr-archive", ODYSSEUS, "gmail.modify", "archive", SAT_11),
];
const CALENDAR = approval("appr-calendar", ODYSSEUS, "calendar.event.create", "events", SAT_11);
const NONE_YET = "None yet";
const UNSHOWN_ONE = "1 remembered approval can't be shown here. brain google approvals lists it.";

function settings(active = true) {
  const root = host();
  const tree = (on: boolean) => <BrainUiProvider root={root}><button type="button">Before</button><GoogleApprovalsSection active={on} /></BrainUiProvider>;
  const view = render(tree(active));
  return {
    root, view,
    list: () => view.container.querySelector<HTMLElement>("[data-google-approvals]"),
    setActive: (on: boolean) => act(() => { view.rerender(tree(on)); }),
  };
}
const rowNames = (scope: HTMLElement) => within(scope).queryAllByRole("button").map(row => row.getAttribute("aria-label")).filter(name => name?.startsWith("Revoke"));
const notice = (scope: HTMLElement) => scope.querySelector("[data-google-unshown]")?.textContent ?? null;
const alertText = (scope: HTMLElement) => scope.querySelector("[role=alert]")?.textContent ?? null;

describe("Settings: remembered Gmail approvals", () => {
  test("GOOGLE_SETTINGS_LOADING: nothing is drawn while the first read is pending, and it reads the owner-only list", () => {
    const s = settings();
    expect(log()).toEqual([READ_APPROVALS]);
    expect(s.list()).toBeNull();
    expect(s.view.container.querySelector("[data-google-approvals-section]")).toBeNull();
  });

  test("GOOGLE_SETTINGS_INACTIVE: an inactive tab reads nothing; opening it reads and draws", async () => {
    const s = settings(false);
    expect(log()).toEqual([]);
    // The positive control: the same tree, active, reads and draws.
    s.setActive(true);
    expect(log()).toEqual([READ_APPROVALS]);
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS });
    expect(s.list()?.getAttribute("data-google-approvals")).toBe("ready");
  });

  test("GOOGLE_SETTINGS_LIST: rows group under each address, newest first, a label by its id", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS });
    const list = s.list()!;
    expect(list.getAttribute("data-google-approvals")).toBe("ready");
    expect([...list.querySelectorAll("[data-google-address]")].map(node => node.textContent)).toEqual([ODYSSEUS, PENELOPE]);
    expect(rowNames(list)).toEqual([
      `Revoke Archive for ${ODYSSEUS}`,
      `Revoke Add label Label_12 for ${ODYSSEUS}`,
      `Revoke Save drafts for ${ODYSSEUS}`,
      `Revoke Remove label Label_7 for ${PENELOPE}`,
    ]);
    expect([...list.querySelectorAll("[data-google-label-id]")].map(node => node.textContent)).toEqual(["Label_12", "Label_7"]);
    expect(list.textContent).toContain("since Sat 11 Jul");
    expect(alertText(list)).toBeNull();
    expect(notice(list)).toBeNull();
    expect(log()).toEqual([READ_APPROVALS]);
  });

  test("GOOGLE_SETTINGS_EMPTY: a first read with no approvals draws no section", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: [] });
    expect(s.list()).toBeNull();
  });

  test("GOOGLE_SETTINGS_UNAVAILABLE: a 503 is the kit's unavailable state", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ error: "Google approval storage is temporarily unavailable." }, 503);
    const list = s.list();
    expect(list?.getAttribute("data-google-approvals")).toBe("unavailable");
    expect(list?.textContent).toContain("Remembered approvals can't be read right now");
    expect(rowNames(list!)).toEqual([]);
  });

  test("GOOGLE_SETTINGS_FAILED: any other failure is the kit's failed state, which claims neither none nor loading", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ error: "Internal" }, 500);
    const list = s.list()!;
    expect(list.getAttribute("data-google-approvals")).toBe("failed");
    expect(list.textContent).toContain("Couldn't load remembered approvals.");
    expect(list.textContent).not.toContain(NONE_YET);
    expect(busyMarks(list), "nothing claims to be running").toBe(0);
    expect(alertText(list), "a read failure is not a revoke error").toBeNull();
  });

  test("GOOGLE_SETTINGS_RETRY: Try again reads the list again, loading while it does", async () => {
    const s = settings();
    await last(APPROVALS_PATH).fail(new TypeError("Failed to fetch"));
    fireEvent.click(within(s.list()!).getByRole("button", { name: "Try again" }));
    expect(s.list()!.getAttribute("data-google-approvals")).toBe("loading");
    expect(busyMarks(s.list()!)).toBe(1);
    expect(log()).toEqual([READ_APPROVALS, READ_APPROVALS]);
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS.slice(3) });
    expect(rowNames(s.list()!)).toEqual([`Revoke Archive for ${ODYSSEUS}`]);
  });

  for (const status of [401, 403, 404]) {
    test(`GOOGLE_SETTINGS_HIDDEN: a ${status} draws no section`, async () => {
      const s = settings();
      await last(APPROVALS_PATH).answer({ error: "no" }, status);
      expect(s.list()).toBeNull();
    });
  }

  test("GOOGLE_SETTINGS_ABSENT_ROUTE: Hono's plain 404 for a route this server lacks hides the section", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answerRaw("404 Not Found", 404, "text/plain; charset=UTF-8");
    expect(s.list()).toBeNull();
  });

  for (const [what, respond] of [
    ["the client shell (a 200 of HTML)", (r: Sent) => r.answerRaw("<!doctype html><main>Ithaca</main>", 200, "text/html; charset=utf-8")],
    ["an empty object", (r: Sent) => r.answer({})],
    ["another route's envelope", (r: Sent) => r.answer({ tools: [] })],
    ["a list that is not an array", (r: Sent) => r.answer({ approvals: { "appr-archive": true } })],
    ["a bare array", (r: Sent) => r.answer([])],
  ] as const) {
    test(`GOOGLE_SETTINGS_MALFORMED_IS_FAILED: ${what} is a failed read, never an absent route`, async () => {
      const s = settings();
      await respond(last(APPROVALS_PATH));
      expect(s.list()?.getAttribute("data-google-approvals")).toBe("failed");
      expect(s.list()!.textContent).not.toContain(NONE_YET);
    });
  }

  test("GOOGLE_SETTINGS_REVOKE: revoke posts the id, drops the row and moves focus to the next row", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS });
    const row = within(s.list()!).getByRole("button", { name: `Revoke Add label Label_12 for ${ODYSSEUS}` });
    act(() => row.focus());
    fireEvent.keyDown(row, { key: "Enter" });
    expect(log()).toEqual([READ_APPROVALS, revokeApproval("appr-voyage")]);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("Revoking…");
    await last(REVOKE_APPROVAL_PATH).answer({ revoked: true });
    expect(rowNames(s.list()!)).toEqual([`Revoke Archive for ${ODYSSEUS}`, `Revoke Save drafts for ${ODYSSEUS}`, `Revoke Remove label Label_7 for ${PENELOPE}`]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(`Revoke Save drafts for ${ODYSSEUS}`);
    expect(log(), "a true revoke reads nothing more").toEqual([READ_APPROVALS, revokeApproval("appr-voyage")]);
  });

  test("revoking the last row leaves the kit's empty state, with focus on its heading", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: [APPROVALS[3]] });
    const row = within(s.list()!).getByRole("button", { name: `Revoke Archive for ${ODYSSEUS}` });
    act(() => row.focus());
    fireEvent.click(row);
    await last(REVOKE_APPROVAL_PATH).answer({ revoked: true });
    expect(s.list()?.textContent).toContain("None yet. Every Gmail change asks first.");
    expect(document.activeElement?.getAttribute("role")).toBe("heading");
  });

  test("GOOGLE_SETTINGS_REVOKE_FALSE: `revoked: false` reads the list again, with no error", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS });
    fireEvent.click(within(s.list()!).getByRole("button", { name: `Revoke Archive for ${ODYSSEUS}` }));
    await last(REVOKE_APPROVAL_PATH).answer({ revoked: false });
    expect(log()).toEqual([READ_APPROVALS, revokeApproval("appr-archive"), READ_APPROVALS]);
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS.filter(row => row.id !== "appr-archive" && row.id !== "appr-drafts") });
    expect(rowNames(s.list()!)).toEqual([`Revoke Add label Label_12 for ${ODYSSEUS}`, `Revoke Remove label Label_7 for ${PENELOPE}`]);
    expect(alertText(s.list()!)).toBeNull();
  });

  test("GOOGLE_SETTINGS_REVOKE_UNAVAILABLE: a revoke answered 503 is the kit's unavailable state", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS });
    fireEvent.click(within(s.list()!).getByRole("button", { name: `Revoke Archive for ${ODYSSEUS}` }));
    await last(REVOKE_APPROVAL_PATH).answer({ error: "Google approval storage is temporarily unavailable." }, 503);
    expect(s.list()?.getAttribute("data-google-approvals")).toBe("unavailable");
    expect(rowNames(s.list()!)).toEqual([]);
    expect(log()).toEqual([READ_APPROVALS, revokeApproval("appr-archive")]);
  });

  test("GOOGLE_SETTINGS_REVOKE_LOST_ANSWER: a failed revoke keeps its banner and reads again; a row the host did revoke goes", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS });
    const row = within(s.list()!).getByRole("button", { name: `Revoke Archive for ${ODYSSEUS}` });
    fireEvent.click(row);
    await last(REVOKE_APPROVAL_PATH).fail(new TypeError("Failed to fetch"));
    expect(alertText(s.list()!)).toBe("Failed to fetch");
    expect(log()).toEqual([READ_APPROVALS, revokeApproval("appr-archive"), READ_APPROVALS]);
    // The host did revoke it; only the answer was lost.
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS.filter(r => r.id !== "appr-archive") });
    expect(rowNames(s.list()!)).not.toContain(`Revoke Archive for ${ODYSSEUS}`);
    expect(rowNames(s.list()!)).toHaveLength(3);
    expect(alertText(s.list()!), "the banner stays through the read").toBe("Failed to fetch");
    expect(within(s.list()!).queryAllByRole("button").some(b => b.getAttribute("aria-disabled") === "true"), "nothing stays busy").toBe(false);
  });

  test("a revoke answered 500 keeps the route's words in the banner and reads again", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS });
    fireEvent.click(within(s.list()!).getByRole("button", { name: `Revoke Archive for ${ODYSSEUS}` }));
    await last(REVOKE_APPROVAL_PATH).answer({ error: "Could not revoke the approval." }, 500);
    expect(alertText(s.list()!)).toBe("Could not revoke the approval.");
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS });
    expect(rowNames(s.list()!)).toHaveLength(4);
    expect(log()).toEqual([READ_APPROVALS, revokeApproval("appr-archive"), READ_APPROVALS]);
  });

  for (const status of [401, 403]) {
    test(`a revoke answered ${status} drops the owner's private list`, async () => {
      const s = settings();
      await last(APPROVALS_PATH).answer({ approvals: APPROVALS });
      fireEvent.click(within(s.list()!).getByRole("button", { name: `Revoke Archive for ${ODYSSEUS}` }));
      await last(REVOKE_APPROVAL_PATH).answer({ error: "Google approvals require owner access." }, status);
      expect(s.list()).toBeNull();
    });
  }

  for (const [what, respond, state] of [
    ["a 503", (r: Sent) => r.answer({ error: "unavailable" }, 503), "unavailable"],
    ["a 500", (r: Sent) => r.answer({ error: "Internal" }, 500), "failed"],
    ["a malformed success", (r: Sent) => r.answer({}), "failed"],
  ] as const) {
    test(`GOOGLE_SETTINGS_REREAD_MAPPING: a re-read answered with ${what} is the kit's ${state} state`, async () => {
      const s = settings();
      await last(APPROVALS_PATH).answer({ approvals: APPROVALS });
      fireEvent.click(within(s.list()!).getByRole("button", { name: `Revoke Archive for ${ODYSSEUS}` }));
      await last(REVOKE_APPROVAL_PATH).answer({ revoked: false });
      await respond(last(APPROVALS_PATH));
      expect(s.list()?.getAttribute("data-google-approvals")).toBe(state);
      expect(rowNames(s.list()!), "rows it can no longer vouch for go").toEqual([]);
    });
  }

  test("GOOGLE_SETTINGS_UNKNOWN_ONLY: approvals the kit has no words for are counted, never called none", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: [CALENDAR] });
    const list = s.list()!;
    expect(list.getAttribute("data-google-approvals")).toBe("ready");
    expect(rowNames(list)).toEqual([]);
    expect(list.textContent).not.toContain(NONE_YET);
    expect(notice(list)).toBe(UNSHOWN_ONE);
    expect(alertText(list), "the count is not a revoke error").toBeNull();
  });

  test("GOOGLE_SETTINGS_REVOKE_LAST_KNOWN: revoking the last nameable row while unknown rows remain never claims none", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: [APPROVALS[3], CALENDAR] });
    fireEvent.click(within(s.list()!).getByRole("button", { name: `Revoke Archive for ${ODYSSEUS}` }));
    await last(REVOKE_APPROVAL_PATH).answer({ revoked: true });
    expect(rowNames(s.list()!)).toEqual([]);
    expect(s.list()!.textContent).not.toContain(NONE_YET);
    expect(notice(s.list()!)).toBe(UNSHOWN_ONE);
  });

  test("the count and a revoke error show together", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: [APPROVALS[3], CALENDAR] });
    fireEvent.click(within(s.list()!).getByRole("button", { name: `Revoke Archive for ${ODYSSEUS}` }));
    await last(REVOKE_APPROVAL_PATH).answer({ error: "Could not revoke the approval." }, 500);
    await last(APPROVALS_PATH).answer({ approvals: [APPROVALS[3], CALENDAR] });
    expect(notice(s.list()!)).toBe(UNSHOWN_ONE);
    expect(alertText(s.list()!)).toBe("Could not revoke the approval.");
  });

  test("GOOGLE_SETTINGS_LATE_REPLY: a read answered after Settings closed sets nothing; reopening reads afresh", async () => {
    const s = settings();
    const first = last(APPROVALS_PATH);
    s.setActive(false);
    await first.answer({ approvals: APPROVALS });
    expect(s.list(), "a closed tab draws nothing from a late answer").toBeNull();
    s.setActive(true);
    expect(log()).toEqual([READ_APPROVALS, READ_APPROVALS]);
    expect(s.list()).toBeNull();
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS.slice(3) });
    expect(rowNames(s.list()!)).toEqual([`Revoke Archive for ${ODYSSEUS}`]);
  });

  test("GOOGLE_SETTINGS_LATE_REVOKE: a revoke answered after Settings closed reads nothing and sets nothing", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS });
    fireEvent.click(within(s.list()!).getByRole("button", { name: `Revoke Archive for ${ODYSSEUS}` }));
    s.setActive(false);
    await last(REVOKE_APPROVAL_PATH).answer({ revoked: false });
    await new Promise(done => setTimeout(done, 0));
    expect(log()).toEqual([READ_APPROVALS, revokeApproval("appr-archive")]);
    expect(s.list()).toBeNull();
  });
});

/* ── A restricted chat: its allowances ─────────────────────────────────── */

const SESSION = "ithaca";
const OTHER_SESSION = "telemachus";
const ALLOWANCES_PATH = `/api/sessions/${SESSION}/google/allowances`;
const REVOKE_ALLOWANCE_PATH = `/api/sessions/${SESSION}/google/allowances/revoke`;
const READ_ALLOWANCES = ["GET", ALLOWANCES_PATH];
const revokeAllowance = (id: string) => ["POST", REVOKE_ALLOWANCE_PATH, { id }];

const allowance = (card: string, operation: string, entity: string, remaining: number, expires: number, account = ODYSSEUS) => ({
  session_id: SESSION, principal_id: "owner-odysseus", brain_id: "brain-ithaca", account_identity: account, operation, entity,
  host_epoch: "epoch-1", policy_hash: "policy-1", granted_card_id: card, granted_at: expires - 86_400_000, expires_at: expires, remaining_items: remaining,
});
// The route's order: by grant time, then entity.
const ALLOWANCES = [
  allowance("card-ithaca", "gmail.modify", "archive", 84, UNTIL_1802),
  allowance("card-ithaca", "gmail.modify", "mark_read", 84, UNTIL_1802),
  allowance("card-drafts", "gmail.draft.save", "drafts", 3, UNTIL_2140),
];
const CALENDAR_CARD = allowance("card-calendar", "calendar.event.create", "events", 100, UNTIL_2140);
const NOTHING_ALLOWED = "Nothing is allowed";
const UNSHOWN_ALLOWANCE = "1 allowance in this chat can't be shown here. It still applies.";

function projection(restriction: "normal" | "restricted"): SafetyHistoryProjection {
  return {
    session: { sessionId: SESSION, historyOwnerId: SESSION, historyGeneration: "0" }, evidenceRevision: "1",
    unresolvedCount: restriction === "restricted" ? 1 : 0, earliestUnresolvedId: null, pendingCount: 0, restriction,
    reasons: restriction === "restricted" ? ["unresolved"] : [],
    coverage: { detectorVersion: 1, state: "complete", epochs: [], exclusions: [] },
  };
}
function restrict(root: BrainUiRoot, restriction: "normal" | "restricted") {
  act(() => root.stores.safety.setState({ supported: true, status: "ready", reason: null, projection: projection(restriction), normal: restriction === "normal" }));
}

interface Call { id: string; name: string; output?: string }
/** An assistant turn holding these tool calls; a call with `output` has its result. */
function turn(calls: Call[]): ChatMessage {
  return {
    id: "odysseus-turn", role: "assistant", content: "", isStreaming: true, timestamp: NOW, parts: [],
    toolCalls: calls.map(call => ({ id: call.id, name: call.name, input: {}, inputJson: "{}", status: call.output === undefined ? "approved" as const : "complete" as const, ...(call.output === undefined ? {} : { output: call.output, isError: false }) })),
  };
}

function chat(restriction: "normal" | "restricted" = "restricted", calls?: Call[]) {
  const root = host(r => r.stores.chat.setState({
    activeSessionId: SESSION,
    ...(calls ? { buffers: { [SESSION]: { messages: [turn(calls)], isStreaming: true, askUser: null, lastTouched: NOW } } } : {}),
  }));
  restrict(root, restriction);
  const view = render(<BrainUiProvider root={root}><SessionSafety /></BrainUiProvider>);
  return { root, view, list: () => view.container.querySelector<HTMLElement>("[data-google-allowances]") };
}
const revokes = (scope: HTMLElement) => within(scope).queryAllByRole("button").map(button => button.getAttribute("aria-label")).filter(name => name?.startsWith("Revoke"));
const metas = (scope: HTMLElement) => [...scope.querySelectorAll("[data-google-meta]")].map(node => node.textContent);

/** Fire `visibilitychange` with the page in `state`; the instance override is removed after. */
async function pageBecomes(state: "visible" | "hidden") {
  const own = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  try {
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  } finally {
    if (own) Object.defineProperty(document, "visibilityState", own);
    else Reflect.deleteProperty(document, "visibilityState");
  }
}

/** The panel's `EXPIRY_GRACE_MS`: how long after an end, or after an answer listing an end already past, it reads. */
const EXPIRY_GRACE = 1_000;

/** One pending timer: the token `setTimeout` returned, when it falls due, and its callback. */
interface Due { at: number; run(): void }

/**
 * Controlled time for the panel's own timers. `Date.now()` and every
 * `setTimeout` with a positive delay follow `advance()`, which runs each
 * callback that falls due at its own time, inside `act`, so the reads and
 * effects it causes land before the next one. Zero-delay timers, the
 * harness's event-loop yields, stay real. A token this returns is never
 * handed to the real `clearTimeout`. Call `restore()` once the tree is gone.
 */
function controlledTime() {
  let now = NOW;
  const due = new Set<Due>();
  const issued = new WeakSet<object>();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  clock!.mockImplementation(() => now);
  const set = spyOn(globalThis, "setTimeout").mockImplementation(((run: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (!(typeof ms === "number" && ms > 0)) return realSetTimeout(run, ms, ...args);
    const timer: Due = { at: now + ms, run: () => run(...args) };
    issued.add(timer);
    due.add(timer);
    return timer;
  }) as unknown as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((timer?: unknown) => {
    if (typeof timer === "object" && timer !== null && issued.has(timer)) { due.delete(timer as Due); return; }
    realClearTimeout(timer as Parameters<typeof clearTimeout>[0]);
  }) as unknown as typeof clearTimeout);
  return {
    now: () => now,
    /** When each pending timer falls due, earliest first. */
    dueTimes: () => [...due].map(timer => timer.at).sort((a, b) => a - b),
    /** The pending timer that falls due at `at`. */
    at: (at: number) => [...due].find(timer => timer.at === at) ?? null,
    pending: (timer: Due) => due.has(timer),
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...due].sort((a, b) => a.at - b.at)[0];
        if (!next || next.at > end) break;
        due.delete(next);
        now = next.at;
        await act(async () => { next.run(); });
      }
      now = end;
    },
    restore: () => { set.mockRestore(); clear.mockRestore(); },
  };
}
type Time = ReturnType<typeof controlledTime>;

/** Run `body` on controlled time; the tree is unmounted before the real timers return. */
async function onControlledTime(body: (time: Time) => Promise<void>) {
  const time = controlledTime();
  try {
    await body(time);
  } finally {
    await act(async () => { cleanup(); });
    time.restore();
  }
}

describe("a restricted chat: Gmail allowances", () => {
  test("GOOGLE_CHAT_RESTRICTED_ONLY: a normal chat reads nothing; the list follows the chat into and out of restriction", async () => {
    const c = chat("normal");
    expect(log()).toEqual([]);
    restrict(c.root, "restricted");
    expect(log()).toEqual([READ_ALLOWANCES]);
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
    expect(c.list()?.getAttribute("data-google-allowances")).toBe("ready");
    restrict(c.root, "normal");
    expect(c.list()).toBeNull();
    // Restricted again: the list opens afresh and reads the host again.
    restrict(c.root, "restricted");
    expect(log()).toEqual([READ_ALLOWANCES, READ_ALLOWANCES]);
    expect(c.list()).toBeNull();
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES.slice(2) });
    expect(revokes(c.list()!)).toEqual(["Revoke Save drafts"]);
  });

  test("the read is the owner-only route of this chat; nothing is drawn while it is pending or when it finds none", async () => {
    const c = chat();
    expect(log()).toEqual([READ_ALLOWANCES]);
    expect(c.list()).toBeNull();
    await last(ALLOWANCES_PATH).answer({ allowances: [] });
    expect(c.list()).toBeNull();
    expect(c.view.container.querySelector("[data-session-safety]")).not.toBeNull();
  });

  test("GOOGLE_CHAT_GROUPING: one row per granting card, with what is left of the backend's budget and when it ends", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
    const list = c.list()!;
    expect(list.querySelectorAll("li[data-google-target]")).toHaveLength(2);
    expect(revokes(list)).toEqual(["Revoke Archive and Mark as read", "Revoke Save drafts"]);
    expect(metas(list)).toEqual([
      `84 of ${GOOGLE_SESSION_ALLOWANCE_LIMITS.items} changes left · until 18:02`,
      `3 of ${GOOGLE_SESSION_ALLOWANCE_LIMITS.items} changes left · until 21:40`,
    ]);
    expect(list.querySelector('[data-google-target="card-drafts"]')?.getAttribute("data-google-grant")).toBe("low");
  });

  test("GOOGLE_CHAT_REVOKE_BY_CARD: Revoke posts the granting card's id to this chat's route", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
    fireEvent.click(within(c.list()!).getByRole("button", { name: "Revoke Archive and Mark as read" }));
    expect(log()).toEqual([READ_ALLOWANCES, revokeAllowance("card-ithaca")]);
  });

  test("GOOGLE_CHAT_REFETCH_AFTER_REVOKE: a successful revoke answer, false or true, is followed by a fresh read, whose rows the list shows", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
    fireEvent.click(within(c.list()!).getByRole("button", { name: "Revoke Save drafts" }));
    await last(REVOKE_ALLOWANCE_PATH).answer({ revoked: false });
    expect(log()).toEqual([READ_ALLOWANCES, revokeAllowance("card-drafts"), READ_ALLOWANCES]);
    // The host's fresh read is what the list shows: here another card has spent changes since.
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES.slice(0, 2).map(row => ({ ...row, remaining_items: 80 })) });
    expect(metas(c.list()!)).toEqual([`80 of ${GOOGLE_SESSION_ALLOWANCE_LIMITS.items} changes left · until 18:02`]);
    expect(alertText(c.list()!)).toBeNull();
    fireEvent.click(within(c.list()!).getByRole("button", { name: "Revoke Archive and Mark as read" }));
    await last(REVOKE_ALLOWANCE_PATH).answer({ revoked: true });
    expect(log()).toEqual([READ_ALLOWANCES, revokeAllowance("card-drafts"), READ_ALLOWANCES, revokeAllowance("card-ithaca"), READ_ALLOWANCES]);
    await last(ALLOWANCES_PATH).answer({ allowances: [] });
    expect(c.list()?.textContent).toContain("Nothing is allowed in this chat.");
  });

  test("GOOGLE_CHAT_TRUE_REVOKE_REREAD: after a true revoke the list shows the host's read, not only the local removal", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
    fireEvent.click(within(c.list()!).getByRole("button", { name: "Revoke Save drafts" }));
    await last(REVOKE_ALLOWANCE_PATH).answer({ revoked: true });
    expect(revokes(c.list()!), "the revoked card goes at once").toEqual(["Revoke Archive and Mark as read"]);
    expect(metas(c.list()!)).toEqual([`84 of ${GOOGLE_ALLOWANCE_ITEMS} changes left · until 18:02`]);
    // Meanwhile the surviving card spent changes: only the read can say so.
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES.slice(0, 2).map(row => ({ ...row, remaining_items: 70 })) });
    expect(metas(c.list()!)).toEqual([`70 of ${GOOGLE_ALLOWANCE_ITEMS} changes left · until 18:02`]);
    expect(log()).toEqual([READ_ALLOWANCES, revokeAllowance("card-drafts"), READ_ALLOWANCES]);
  });

  test("GOOGLE_CHAT_REVOKE_LOST_ANSWER: a failed revoke keeps its banner and reads again; a card the host did revoke goes", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
    fireEvent.click(within(c.list()!).getByRole("button", { name: "Revoke Save drafts" }));
    await last(REVOKE_ALLOWANCE_PATH).fail(new TypeError("Failed to fetch"));
    expect(alertText(c.list()!)).toBe("Failed to fetch");
    expect(log()).toEqual([READ_ALLOWANCES, revokeAllowance("card-drafts"), READ_ALLOWANCES]);
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES.slice(0, 2) });
    expect(revokes(c.list()!)).toEqual(["Revoke Archive and Mark as read"]);
    expect(alertText(c.list()!), "the banner stays through the read").toBe("Failed to fetch");
  });

  test("GOOGLE_CHAT_REVOKE_UNAVAILABLE: a revoke answered 503 is the kit's unavailable state", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
    fireEvent.click(within(c.list()!).getByRole("button", { name: "Revoke Save drafts" }));
    await last(REVOKE_ALLOWANCE_PATH).answer({ error: "Google approval storage is temporarily unavailable." }, 503);
    expect(c.list()?.getAttribute("data-google-allowances")).toBe("unavailable");
    expect(revokes(c.list()!)).toEqual([]);
    expect(log()).toEqual([READ_ALLOWANCES, revokeAllowance("card-drafts")]);
  });

  for (const status of [401, 403, 404]) {
    test(`GOOGLE_CHAT_HIDDEN: a read answered ${status} draws no list, and so does a revoke answered ${status}`, async () => {
      const c = chat();
      await last(ALLOWANCES_PATH).answer({ error: "no" }, status);
      expect(c.list()).toBeNull();
      const d = chat();
      await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
      fireEvent.click(within(d.list()!).getByRole("button", { name: "Revoke Save drafts" }));
      await last(REVOKE_ALLOWANCE_PATH).answer({ error: "no" }, status);
      expect(d.list()).toBeNull();
    });
  }

  for (const [status, state] of [[503, "unavailable"], [403, null], [404, null]] as const) {
    test(`GOOGLE_CHAT_REVOKE_SUPERSEDES_READ: a read sent before a revoke answered ${status} cannot undo it; a read sent after it can`, async () => {
      const c = chat();
      await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
      await pageBecomes("visible");
      const earlier = last(ALLOWANCES_PATH);
      fireEvent.click(within(c.list()!).getByRole("button", { name: "Revoke Save drafts" }));
      await last(REVOKE_ALLOWANCE_PATH).answer({ error: "no" }, status);
      const drawn = () => c.list()?.getAttribute("data-google-allowances") ?? null;
      expect(c.view.container.querySelector("[data-session-safety]"), "the safety notice is still drawn").not.toBeNull();
      expect(drawn(), `a revoke answered ${status}`).toBe(state);
      await earlier.answer({ allowances: ALLOWANCES });
      expect(drawn(), "an answer to a read sent before the revoke's answer is discarded").toBe(state);
      expect(log()).toEqual([READ_ALLOWANCES, READ_ALLOWANCES, revokeAllowance("card-drafts")]);
      // A fresh read, sent after the revoke's answer, may still recover the list.
      await pageBecomes("visible");
      await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES.slice(0, 2) });
      expect(drawn()).toBe("ready");
      expect(revokes(c.list()!)).toEqual(["Revoke Archive and Mark as read"]);
      expect(log()).toEqual([READ_ALLOWANCES, READ_ALLOWANCES, revokeAllowance("card-drafts"), READ_ALLOWANCES]);
    });
  }

  test("GOOGLE_CHAT_UNAVAILABLE: a 503 is the kit's unavailable state", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ error: "Google approval storage is temporarily unavailable." }, 503);
    expect(c.list()?.getAttribute("data-google-allowances")).toBe("unavailable");
    expect(c.list()?.textContent).toContain("Allowances for this chat can't be read right now");
  });

  test("GOOGLE_CHAT_FAILED: any other failure, a malformed success included, is the kit's failed state, and Try again reads again", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ error: "Internal" }, 500);
    expect(c.list()?.getAttribute("data-google-allowances")).toBe("failed");
    expect(c.list()!.textContent).not.toContain(NOTHING_ALLOWED);
    expect(busyMarks(c.list()!)).toBe(0);
    fireEvent.click(within(c.list()!).getByRole("button", { name: "Try again" }));
    expect(c.list()?.getAttribute("data-google-allowances")).toBe("loading");
    await last(ALLOWANCES_PATH).answerRaw("<!doctype html><main>Ithaca</main>", 200, "text/html");
    expect(c.list()?.getAttribute("data-google-allowances"), "the client shell is a failed read").toBe("failed");
    fireEvent.click(within(c.list()!).getByRole("button", { name: "Try again" }));
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
    expect(revokes(c.list()!)).toEqual(["Revoke Archive and Mark as read", "Revoke Save drafts"]);
    expect(log()).toEqual([READ_ALLOWANCES, READ_ALLOWANCES, READ_ALLOWANCES]);
  });

  test("GOOGLE_CHAT_UNKNOWN_ONLY: allowances the kit has no words for are counted, never called nothing allowed", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ allowances: [CALENDAR_CARD] });
    expect(revokes(c.list()!)).toEqual([]);
    expect(c.list()!.textContent).not.toContain(NOTHING_ALLOWED);
    expect(notice(c.list()!)).toBe(UNSHOWN_ALLOWANCE);
    expect(alertText(c.list()!)).toBeNull();
  });

  test("a card with a change the kit has no words for is not shown, and the list counts it", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ allowances: [...ALLOWANCES, CALENDAR_CARD, allowance("card-drafts", "gmail.modify", "snooze", 3, UNTIL_2140)] });
    expect(revokes(c.list()!)).toEqual(["Revoke Archive and Mark as read"]);
    expect(notice(c.list()!)).toBe("2 allowances in this chat can't be shown here. They still apply.");
  });

  test("GOOGLE_CHAT_REVOKE_LAST_KNOWN: revoking the last nameable card while unknown ones remain never claims nothing allowed", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ allowances: [ALLOWANCES[2], CALENDAR_CARD] });
    fireEvent.click(within(c.list()!).getByRole("button", { name: "Revoke Save drafts" }));
    await last(REVOKE_ALLOWANCE_PATH).answer({ revoked: true });
    expect(c.list()!.textContent).not.toContain(NOTHING_ALLOWED);
    await last(ALLOWANCES_PATH).answer({ allowances: [CALENDAR_CARD] });
    expect(revokes(c.list()!)).toEqual([]);
    expect(c.list()!.textContent).not.toContain(NOTHING_ALLOWED);
    expect(notice(c.list()!)).toBe(UNSHOWN_ALLOWANCE);
  });

  test("GOOGLE_CHAT_REREAD_ON_WRITE: a Gmail modify or draft call with its result reads again; other calls do not", async () => {
    const c = chat("restricted", [
      { id: "toolu_modify", name: `mcp__brain-ui__${GMAIL_TOOL_NAMES.modify}` },
      { id: "toolu_draft", name: GMAIL_TOOL_NAMES.draft },
      { id: "toolu_search", name: `mcp__brain-ui__${GMAIL_TOOL_NAMES.search}` },
      { id: "toolu_brain", name: "mcp__brain__brain_search" },
    ]);
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
    const result = (id: string) => act(() => { c.root.stores.chat.getState().setToolResult(SESSION, id, "done", false); });
    result("toolu_search");
    result("toolu_brain");
    expect(log(), "a read tool or another tool spends no allowance").toEqual([READ_ALLOWANCES]);
    result("toolu_modify");
    expect(log()).toEqual([READ_ALLOWANCES, READ_ALLOWANCES]);
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES.map(row => (row.granted_card_id === "card-ithaca" ? { ...row, remaining_items: 81 } : row)) });
    expect(metas(c.list()!)[0]).toBe(`81 of ${GOOGLE_ALLOWANCE_ITEMS} changes left · until 18:02`);
    result("toolu_draft");
    expect(log()).toEqual([READ_ALLOWANCES, READ_ALLOWANCES, READ_ALLOWANCES]);
  });

  test("a write in a chat that shows no list yet reads, and draws the card it granted", async () => {
    const c = chat("restricted", [{ id: "toolu_modify", name: GMAIL_TOOL_NAMES.modify }]);
    await last(ALLOWANCES_PATH).answer({ allowances: [] });
    expect(c.list()).toBeNull();
    act(() => { c.root.stores.chat.getState().setToolResult(SESSION, "toolu_modify", "done", false); });
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES.slice(0, 2) });
    expect(revokes(c.list()!)).toEqual(["Revoke Archive and Mark as read"]);
    expect(log()).toEqual([READ_ALLOWANCES, READ_ALLOWANCES]);
  });

  test("GOOGLE_CHAT_REREAD_AT_EXPIRY: one read just after the earliest end; a host still listing it is reconciled once; the next end follows", async () => {
    await onControlledTime(async time => {
      const c = chat();
      await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
      expect(time.dueTimes(), "one timer, for the earliest end").toEqual([UNTIL_1802 + EXPIRY_GRACE]);
      await time.advance(UNTIL_1802 + EXPIRY_GRACE - NOW - 1);
      expect(log(), "nothing before the end and its grace").toEqual([READ_ALLOWANCES]);
      await time.advance(1);
      expect(log(), "one read at the end and its grace").toEqual([READ_ALLOWANCES, READ_ALLOWANCES]);
      // The host still lists that card (its clock runs behind): the card stays, and one reconcile read follows.
      await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
      expect(revokes(c.list()!)).toEqual(["Revoke Archive and Mark as read", "Revoke Save drafts"]);
      expect(time.dueTimes(), "a reconcile read for the end the host still lists, and the next end's").toEqual([UNTIL_1802 + 2 * EXPIRY_GRACE, UNTIL_2140 + EXPIRY_GRACE]);
      await time.advance(EXPIRY_GRACE);
      expect(log()).toEqual([READ_ALLOWANCES, READ_ALLOWANCES, READ_ALLOWANCES]);
      await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
      expect(time.dueTimes(), "that end is never reconciled again, and the next end keeps its timer: no polling").toEqual([UNTIL_2140 + EXPIRY_GRACE]);
      await time.advance(UNTIL_2140 + EXPIRY_GRACE - time.now() - 1);
      expect(log()).toEqual([READ_ALLOWANCES, READ_ALLOWANCES, READ_ALLOWANCES]);
      await time.advance(1);
      expect(log()).toEqual([READ_ALLOWANCES, READ_ALLOWANCES, READ_ALLOWANCES, READ_ALLOWANCES]);
      // By now the host has dropped both cards.
      await last(ALLOWANCES_PATH).answer({ allowances: [] });
      expect(c.list()?.textContent).toContain("Nothing is allowed in this chat.");
      expect(time.dueTimes(), "no end is left to wait for").toEqual([]);
    });
  });

  test("GOOGLE_CHAT_EXPIRED_ON_ARRIVAL: a card whose end passed in transit stays as the host listed it, and one read reconciles it", async () => {
    await onControlledTime(async time => {
      const c = chat();
      // The host read this card live at NOW; its answer lands two seconds later, a second past the card's end.
      await time.advance(2_000);
      await last(ALLOWANCES_PATH).answer({ allowances: [allowance("card-boundary", "gmail.modify", "star", 40, NOW + 1_000)] });
      expect(c.list()?.getAttribute("data-google-allowances"), "the host decides the card is live: the list is drawn").toBe("ready");
      expect(revokes(c.list()!), "the host decides the card is live").toEqual(["Revoke Star"]);
      expect(metas(c.list()!)).toEqual([`40 of ${GOOGLE_ALLOWANCE_ITEMS} changes left · until 09:41`]);
      expect(time.dueTimes(), "one reconcile read").toEqual([NOW + 2_000 + EXPIRY_GRACE]);
      await time.advance(EXPIRY_GRACE - 1);
      expect(log()).toEqual([READ_ALLOWANCES]);
      await time.advance(1);
      expect(log()).toEqual([READ_ALLOWANCES, READ_ALLOWANCES]);
      // The host has dropped it by now.
      await last(ALLOWANCES_PATH).answer({ allowances: [] });
      expect(revokes(c.list()!)).toEqual([]);
      expect(c.list()?.textContent).toContain("Nothing is allowed in this chat.");
      expect(time.dueTimes()).toEqual([]);
    });
  });

  test("GOOGLE_CHAT_STALE_END_NO_STARVE: an end already past never holds back a later end's read", async () => {
    await onControlledTime(async time => {
      const c = chat();
      const rows = [allowance("card-stale", "gmail.modify", "star", 40, NOW - 60_000), ...ALLOWANCES.slice(2)];
      await last(ALLOWANCES_PATH).answer({ allowances: rows });
      expect(revokes(c.list()!)).toEqual(["Revoke Star", "Revoke Save drafts"]);
      expect(time.dueTimes(), "a reconcile read, and the later end's own").toEqual([NOW + EXPIRY_GRACE, UNTIL_2140 + EXPIRY_GRACE]);
      await time.advance(EXPIRY_GRACE);
      expect(log()).toEqual([READ_ALLOWANCES, READ_ALLOWANCES]);
      // The host still lists the stale card: only the later end is left to wait for.
      await last(ALLOWANCES_PATH).answer({ allowances: rows });
      expect(time.dueTimes(), "only the later end is left to wait for").toEqual([UNTIL_2140 + EXPIRY_GRACE]);
      await time.advance(UNTIL_2140 + EXPIRY_GRACE - time.now() - 1);
      expect(log()).toEqual([READ_ALLOWANCES, READ_ALLOWANCES]);
      await time.advance(1);
      expect(log(), "the later end's read").toEqual([READ_ALLOWANCES, READ_ALLOWANCES, READ_ALLOWANCES]);
    });
  });

  test("GOOGLE_CHAT_PAST_END_ONCE: one past end is reconciled once however often the host lists it; another is reconciled in its turn", async () => {
    await onControlledTime(async time => {
      const c = chat();
      const stale = allowance("card-stale", "gmail.modify", "star", 40, NOW - 60_000);
      await last(ALLOWANCES_PATH).answer({ allowances: [stale] });
      await time.advance(EXPIRY_GRACE);
      expect(log(), "one reconcile read for the past end").toEqual([READ_ALLOWANCES, READ_ALLOWANCES]);
      await last(ALLOWANCES_PATH).answer({ allowances: [stale] });
      expect(time.dueTimes(), "nothing more for that end").toEqual([]);
      // A read for another reason lists it again: still nothing more.
      await pageBecomes("visible");
      await last(ALLOWANCES_PATH).answer({ allowances: [stale] });
      expect(time.dueTimes()).toEqual([]);
      await time.advance(86_400_000);
      expect(log(), "one reconcile read in all").toEqual([READ_ALLOWANCES, READ_ALLOWANCES, READ_ALLOWANCES]);
      // A day on, a card whose end has just passed: its own one reconcile read. The stale end, a day back, reads with its date.
      await pageBecomes("visible");
      await last(ALLOWANCES_PATH).answer({ allowances: [stale, allowance("card-late", "gmail.modify", "archive", 9, time.now() - 5_000)] });
      expect(metas(c.list()!), "an end on an earlier day reads with its date").toEqual([
        `40 of ${GOOGLE_ALLOWANCE_ITEMS} changes left · until Sun 12 Jul 09:40`,
        `9 of ${GOOGLE_ALLOWANCE_ITEMS} changes left · until 09:40`,
      ]);
      expect(time.dueTimes()).toEqual([time.now() + EXPIRY_GRACE]);
      await time.advance(EXPIRY_GRACE);
      await last(ALLOWANCES_PATH).answer({ allowances: [stale, allowance("card-late", "gmail.modify", "archive", 9, time.now() - 6_000)] });
      expect(time.dueTimes(), "each end once").toEqual([]);
      expect(log()).toEqual([READ_ALLOWANCES, READ_ALLOWANCES, READ_ALLOWANCES, READ_ALLOWANCES, READ_ALLOWANCES]);
    });
  });

  for (const [timer, rows, dueAt] of [
    ["the expiry timer", () => ALLOWANCES, UNTIL_1802 + EXPIRY_GRACE],
    ["the reconcile timer", () => [allowance("card-stale", "gmail.modify", "star", 40, NOW - 60_000)], NOW + EXPIRY_GRACE],
  ] as const) {
    for (const [exit, leave] of [
      ["unmounting", async (c: ReturnType<typeof chat>) => { act(() => { c.view.unmount(); }); }],
      ["switching chats", async (c: ReturnType<typeof chat>) => { act(() => { c.root.stores.chat.setState({ activeSessionId: OTHER_SESSION }); }); }],
      ["leaving ready", async (c: ReturnType<typeof chat>) => {
        await pageBecomes("visible");
        await last(ALLOWANCES_PATH).answer({ error: "Internal" }, 500);
        expect(c.list()?.getAttribute("data-google-allowances")).toBe("failed");
      }],
    ] as const) {
      test(`GOOGLE_CHAT_TIMER_CLEANUP: ${exit} cancels ${timer}, the one scheduled, and it never reads`, async () => {
        await onControlledTime(async time => {
          const c = chat();
          await last(ALLOWANCES_PATH).answer({ allowances: rows() });
          const scheduled = time.at(dueAt);
          expect(scheduled, `${timer} is scheduled`).not.toBeNull();
          await leave(c);
          expect(time.pending(scheduled!), `${exit} cancels it`).toBe(false);
          const reads = requests(ALLOWANCES_PATH).length;
          await time.advance(dueAt - time.now() + 60_000);
          expect(requests(ALLOWANCES_PATH).length, "nothing reads this chat once it has gone").toBe(reads);
        });
      });
    }
  }

  test("GOOGLE_CHAT_REREAD_ON_VISIBLE: the page becoming visible reads again and formats the times afresh; hidden reads nothing", async () => {
    const MON_0730 = new Date(2026, 6, 13, 7, 30).getTime();
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ allowances: [allowance("card-dawn", "gmail.modify", "star", 40, MON_0730)] });
    expect(metas(c.list()!)).toEqual([`40 of ${GOOGLE_ALLOWANCE_ITEMS} changes left · until Mon 07:30`]);
    await pageBecomes("hidden");
    expect(log()).toEqual([READ_ALLOWANCES]);
    // Past midnight, the page comes back: the same end is now today.
    clock!.mockReturnValue(new Date(2026, 6, 13, 0, 10).getTime());
    await pageBecomes("visible");
    expect(log()).toEqual([READ_ALLOWANCES, READ_ALLOWANCES]);
    await last(ALLOWANCES_PATH).answer({ allowances: [allowance("card-dawn", "gmail.modify", "star", 40, MON_0730)] });
    expect(metas(c.list()!)).toEqual([`40 of ${GOOGLE_ALLOWANCE_ITEMS} changes left · until 07:30`]);
  });

  for (const [what, respond, state] of [
    ["a 503", (r: Sent) => r.answer({ error: "unavailable" }, 503), "unavailable"],
    ["a 500", (r: Sent) => r.answer({ error: "Internal" }, 500), "failed"],
    ["a malformed success", (r: Sent) => r.answer({ allowances: null }), "failed"],
  ] as const) {
    test(`GOOGLE_CHAT_REREAD_MAPPING: a re-read answered with ${what} is the kit's ${state} state`, async () => {
      const c = chat();
      await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
      await pageBecomes("visible");
      await respond(last(ALLOWANCES_PATH));
      expect(c.list()?.getAttribute("data-google-allowances")).toBe(state);
      expect(revokes(c.list()!)).toEqual([]);
    });
  }

  test("GOOGLE_CHAT_STALE_READ: an older read answered after a newer one sets nothing", async () => {
    const c = chat();
    const first = last(ALLOWANCES_PATH);
    await pageBecomes("visible");
    const second = last(ALLOWANCES_PATH);
    expect(second).not.toBe(first);
    await second.answer({ allowances: ALLOWANCES.slice(2) });
    await first.answer({ allowances: ALLOWANCES });
    expect(revokes(c.list()!)).toEqual(["Revoke Save drafts"]);
  });

  test("GOOGLE_CHAT_LATE_REPLY: after switching chats, the old chat's late answers set nothing and read nothing", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
    fireEvent.click(within(c.list()!).getByRole("button", { name: "Revoke Save drafts" }));
    await pageBecomes("visible");
    const pendingRead = last(ALLOWANCES_PATH);
    const pendingRevoke = last(REVOKE_ALLOWANCE_PATH);
    act(() => { c.root.stores.chat.setState({ activeSessionId: OTHER_SESSION }); });
    // The other chat is restricted too, once its own projection is read.
    restrict(c.root, "restricted");
    const otherPath = `/api/sessions/${OTHER_SESSION}/google/allowances`;
    expect(log().at(-1)).toEqual(["GET", otherPath]);
    expect(c.list(), "the new chat's list waits for its own read").toBeNull();
    await pendingRead.answer({ allowances: ALLOWANCES });
    await pendingRevoke.answer({ revoked: false });
    expect(c.list(), "nothing from the old chat is drawn").toBeNull();
    await pageBecomes("visible");
    expect(log(), "the old chat neither re-reads after its revoke nor listens to the page").toEqual([
      READ_ALLOWANCES, revokeAllowance("card-drafts"), READ_ALLOWANCES, ["GET", otherPath], ["GET", otherPath],
    ]);
    await last(otherPath).answer({ allowances: [{ ...ALLOWANCES[2], session_id: OTHER_SESSION }] });
    expect(revokes(c.list()!)).toEqual(["Revoke Save drafts"]);
  });
});

/* ── The host's words and times ────────────────────────────────────────── */

describe("mapping", () => {
  test("GOOGLE_LIMIT_FROM_SOURCE: the per-card budget is the backend's", () => {
    expect(GOOGLE_ALLOWANCE_ITEMS).toBe(GOOGLE_SESSION_ALLOWANCE_LIMITS.items);
  });

  test("GOOGLE_WRITE_TOOLS_FROM_SOURCE: the writes that spend an allowance are the catalog's reversible ones", () => {
    expect(GOOGLE_ALLOWANCE_WRITE_TOOLS).toEqual([GMAIL_TOOL_NAMES.modify, GMAIL_TOOL_NAMES.draft]);
  });

  test("a write counts once it has its result, under any MCP prefix", () => {
    const calls = (list: Call[]) => completedAllowanceWrites([turn(list)]);
    expect(calls([{ id: "a", name: GMAIL_TOOL_NAMES.modify }])).toBe(0);
    expect(calls([{ id: "a", name: GMAIL_TOOL_NAMES.modify, output: "" }])).toBe(1);
    expect(calls([{ id: "a", name: `mcp__brain-ui__${GMAIL_TOOL_NAMES.draft}`, output: "ok" }, { id: "b", name: GMAIL_TOOL_NAMES.send, output: "ok" }, { id: "c", name: GMAIL_TOOL_NAMES.trash, output: "ok" }])).toBe(1);
    expect(completedAllowanceWrites(undefined)).toBe(0);
  });

  test("every stored entity maps to the kit's action, and nothing else does", () => {
    expect(["archive", "unarchive", "mark_read", "mark_unread", "star", "unstar"].map(entity => standingAction("gmail.modify", entity)?.kind))
      .toEqual(["archive", "unarchive", "mark_read", "mark_unread", "star", "unstar"]);
    expect(standingAction("gmail.modify", "label:Label_31")).toEqual({ kind: "label", labelId: "Label_31", labelName: null });
    expect(standingAction("gmail.modify", "unlabel:Label_7")).toEqual({ kind: "unlabel", labelId: "Label_7", labelName: null });
    expect(standingAction("gmail.draft.save", "drafts")).toEqual({ kind: "drafts" });
    for (const [operation, entity] of [["gmail.modify", "drafts"], ["gmail.draft.save", "archive"], ["gmail.send", "none"], ["gmail.modify", "label:"], [1, "archive"]])
      expect(standingAction(operation, entity)).toBeNull();
  });

  test("times read in this device's zone: a date for since, a clock for until", () => {
    expect(sinceTime(SAT_11, NOW)).toEqual({ short: "Sat 11 Jul", full: "Saturday 11 July 2026 at 09:14" });
    expect(sinceTime(new Date(2025, 11, 31, 23, 5).getTime(), NOW)).toEqual({ short: "Wed 31 Dec 2025", full: "Wednesday 31 December 2025 at 23:05" });
    expect(untilTime(UNTIL_1802, NOW)).toEqual({ short: "18:02", full: "Sunday 12 July 2026 at 18:02" });
    expect(untilTime(new Date(2026, 6, 13, 7, 30).getTime(), NOW)).toEqual({ short: "Mon 07:30", full: "Monday 13 July 2026 at 07:30" });
    // An end on an earlier day, while this device's clock runs ahead of the host's: never a bare weekday, which reads as the coming one.
    expect(untilTime(new Date(2026, 6, 11, 23, 59).getTime(), NOW)).toEqual({ short: "Sat 11 Jul 23:59", full: "Saturday 11 July 2026 at 23:59" });
    expect(untilTime(new Date(2026, 6, 12, 8, 0).getTime(), NOW), "earlier today is still its clock").toEqual({ short: "08:00", full: "Sunday 12 July 2026 at 08:00" });
  });

  test("a card shows the least left and the earliest end any of its rows reports; the list's next end is the earliest shown still ahead", () => {
    const { grants, nextEnd, pastEnds } = allowanceGrants([allowance("card-a", "gmail.modify", "star", 9, UNTIL_2140), allowance("card-a", "gmail.modify", "archive", 7, UNTIL_1802)], NOW);
    expect(grants).toEqual([{ id: "card-a", address: ODYSSEUS, actions: [{ kind: "star" }, { kind: "archive" }], remaining: 7, limit: 100, until: untilTime(UNTIL_1802, NOW) }]);
    expect(nextEnd).toBe(UNTIL_1802);
    expect(pastEnds).toEqual([]);
    expect(allowanceGrants([CALENDAR_CARD], NOW).nextEnd, "an unshown card arms no timer").toBeNull();
  });

  test("a shown card whose end is past by this device's clock stays, and its end is a past end, each once", () => {
    const { grants, nextEnd, pastEnds } = allowanceGrants([
      allowance("card-a", "gmail.modify", "star", 9, NOW - 1_000),
      allowance("card-b", "gmail.modify", "archive", 7, UNTIL_2140),
      allowance("card-c", "gmail.modify", "mark_read", 5, NOW - 60_000),
      allowance("card-d", "gmail.modify", "unstar", 5, NOW - 1_000),
      allowance("card-e", "gmail.modify", "archive", 3, NOW),
    ], NOW);
    expect(grants.map(grant => grant.id), "the host decides which cards are live").toEqual(["card-a", "card-b", "card-c", "card-d", "card-e"]);
    expect(nextEnd, "the earliest end still ahead").toBe(UNTIL_2140);
    expect(pastEnds, "an end at or before now, each once, earliest first").toEqual([NOW - 60_000, NOW - 1_000, NOW]);
  });

  test("accounts sort by address and approvals run newest first, however the host ordered them", () => {
    const { accounts, unshown } = approvalAccounts([
      approval("appr-estate", PENELOPE, "gmail.modify", "label:Label_31", WED_8),
      approval("appr-star", ODYSSEUS, "gmail.modify", "star", THU_9),
      approval("appr-suitors", PENELOPE, "gmail.modify", "unlabel:Label_7", FRI_10),
    ], NOW);
    expect(unshown).toBe(0);
    expect(accounts.map(account => [account.address, account.approvals.map(row => row.id)])).toEqual([
      [ODYSSEUS, ["appr-star"]],
      [PENELOPE, ["appr-suitors", "appr-estate"]],
    ]);
  });
});
