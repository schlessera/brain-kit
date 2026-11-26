// Standing Gmail permissions wired to the owner-only routes (#4212): the
// Settings container for `GoogleApprovalList` and the restricted chat's
// container for `GoogleAllowanceList`. Same containment contract as
// render-smoke.test.tsx: the DOM module first, `afterAll(unregister)`,
// queries off `render()` and never `screen`. The double is the root's
// `request`, the one transport every API call goes through.
import { registerGoogleStandingDom, unregisterGoogleStandingDom } from "./google-standing-dom.js";

registerGoogleStandingDom();

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { GOOGLE_SESSION_ALLOWANCE_LIMITS } from "@schlessera/brain-common/internal/google-operations";
import type { SafetyHistoryProjection } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { GoogleApprovalsSection } from "../../src/components/settings/google-approvals.js";
import { SessionSafety } from "../../src/components/chat/safety-indicator.js";
import { GOOGLE_ALLOWANCE_ITEMS, allowanceGrants, approvalAccounts, sinceTime, standingAction, untilTime } from "../../src/lib/google-standing.js";

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

interface Sent { url: string; path: string; method: string; type: string | null; body: unknown; answer(body: unknown, status?: number): Promise<void>; fail(error: Error): Promise<void> }
const roots: BrainUiRoot[] = [];
let sent: Sent[] = [];
let clock: ReturnType<typeof spyOn> | undefined;

beforeEach(() => { clock = spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(async () => {
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

/* ── Settings › Security: remembered approvals ─────────────────────────── */

const APPROVALS_PATH = "/api/google/approvals";
const REVOKE_APPROVAL_PATH = "/api/google/approvals/revoke";

const approval = (id: string, account: string, operation: string, entity: string, approved_at: number) =>
  ({ id, principal_id: "owner-odysseus", brain_id: "brain-ithaca", account_identity: account, operation, entity, approved_at });
// The route's order: oldest first.
const APPROVALS = [
  approval("appr-drafts", ODYSSEUS, "gmail.draft.save", "drafts", THU_9),
  approval("appr-suitors", PENELOPE, "gmail.modify", "unlabel:Label_7", THU_9),
  approval("appr-voyage", ODYSSEUS, "gmail.modify", "label:Label_12", FRI_10),
  approval("appr-archive", ODYSSEUS, "gmail.modify", "archive", SAT_11),
];

function settings(active = true) {
  const root = host();
  const view = render(<BrainUiProvider root={root}><button type="button">Before</button><GoogleApprovalsSection active={active} /></BrainUiProvider>);
  return { root, view, list: () => view.container.querySelector<HTMLElement>("[data-google-approvals]") };
}
const rowNames = (scope: HTMLElement) => within(scope).queryAllByRole("button").map(row => row.getAttribute("aria-label")).filter(name => name?.startsWith("Revoke"));

describe("Settings: remembered Gmail approvals", () => {
  test("GOOGLE_SETTINGS_LOADING: nothing is drawn while the first read is pending, and it reads the owner-only list", () => {
    const s = settings();
    expect(requests(APPROVALS_PATH)).toHaveLength(1);
    const read = last(APPROVALS_PATH);
    expect({ path: read.path, method: read.method, body: read.body }).toEqual({ path: APPROVALS_PATH, method: "GET", body: undefined });
    expect(s.list()).toBeNull();
    expect(s.view.container.querySelector("[data-google-approvals-section]")).toBeNull();
  });

  test("an inactive tab reads nothing", () => {
    settings(false);
    expect(requests(APPROVALS_PATH)).toHaveLength(0);
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
    expect(list.querySelector("[role=alert]")).toBeNull();
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

  test("GOOGLE_SETTINGS_ERROR: any other failure is an error the section shows, and never claims there are none", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ error: "Internal" }, 500);
    const list = s.list()!;
    expect(within(list).getByRole("alert").textContent).toBe("Remembered Gmail approvals didn't load. Open Settings again to try again.");
    expect(list.textContent).not.toContain("None yet");
    expect(list.getAttribute("data-google-approvals")).not.toBe("unavailable");
  });

  for (const status of [401, 403, 404]) {
    test(`GOOGLE_SETTINGS_HIDDEN: a ${status} draws no section`, async () => {
      const s = settings();
      await last(APPROVALS_PATH).answer({ error: "no" }, status);
      expect(s.list()).toBeNull();
    });
  }

  test("a 200 without the list is a server without the route: no section", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ tools: [] });
    expect(s.list()).toBeNull();
  });

  test("GOOGLE_SETTINGS_REVOKE: revoke posts the id, drops the row and moves focus to the next row", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS });
    const row = within(s.list()!).getByRole("button", { name: `Revoke Add label Label_12 for ${ODYSSEUS}` });
    act(() => row.focus());
    fireEvent.keyDown(row, { key: "Enter" });
    const post = last(REVOKE_APPROVAL_PATH);
    expect({ path: post.path, method: post.method, type: post.type, body: post.body }).toEqual({ path: REVOKE_APPROVAL_PATH, method: "POST", type: "application/json", body: { id: "appr-voyage" } });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("Revoking…");
    await post.answer({ revoked: true });
    expect(rowNames(s.list()!)).toEqual([`Revoke Archive for ${ODYSSEUS}`, `Revoke Save drafts for ${ODYSSEUS}`, `Revoke Remove label Label_7 for ${PENELOPE}`]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe(`Revoke Save drafts for ${ODYSSEUS}`);
    expect(requests(APPROVALS_PATH)).toHaveLength(1);
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
    expect(requests(APPROVALS_PATH)).toHaveLength(2);
    const reread = last(APPROVALS_PATH);
    expect({ method: reread.method, body: reread.body }).toEqual({ method: "GET", body: undefined });
    await reread.answer({ approvals: APPROVALS.filter(row => row.id !== "appr-archive" && row.id !== "appr-drafts") });
    expect(rowNames(s.list()!)).toEqual([`Revoke Add label Label_12 for ${ODYSSEUS}`, `Revoke Remove label Label_7 for ${PENELOPE}`]);
    expect(s.list()!.querySelector("[role=alert]")).toBeNull();
  });

  test("GOOGLE_SETTINGS_REVOKE_ERROR: a failed revoke keeps the rows and shows the kit's revoke error", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS });
    const row = within(s.list()!).getByRole("button", { name: `Revoke Archive for ${ODYSSEUS}` });
    fireEvent.click(row);
    await last(REVOKE_APPROVAL_PATH).answer({ error: "Google approval storage is temporarily unavailable." }, 503);
    const list = s.list()!;
    expect(within(list).getByRole("alert").textContent).toBe("Google approval storage is temporarily unavailable.");
    expect(rowNames(list)).toHaveLength(4);
    expect(row.getAttribute("aria-disabled")).toBeNull();
    expect(requests(APPROVALS_PATH)).toHaveLength(1);
  });

  test("a revoke answered 403 drops the owner's private list", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: APPROVALS });
    fireEvent.click(within(s.list()!).getByRole("button", { name: `Revoke Archive for ${ODYSSEUS}` }));
    await last(REVOKE_APPROVAL_PATH).answer({ error: "Google approvals require owner access." }, 403);
    expect(s.list()).toBeNull();
  });

  test("a row the kit has no words for is counted, never dropped silently", async () => {
    const s = settings();
    await last(APPROVALS_PATH).answer({ approvals: [APPROVALS[3], approval("appr-calendar", ODYSSEUS, "calendar.event.create", "events", SAT_11)] });
    const list = s.list()!;
    expect(rowNames(list)).toEqual([`Revoke Archive for ${ODYSSEUS}`]);
    expect(within(list).getByRole("alert").textContent).toBe("1 remembered approval can't be shown here. brain google approvals lists it.");
  });
});

/* ── A restricted chat: its allowances ─────────────────────────────────── */

const SESSION = "ithaca";
const ALLOWANCES_PATH = `/api/sessions/${SESSION}/google/allowances`;
const REVOKE_ALLOWANCE_PATH = `/api/sessions/${SESSION}/google/allowances/revoke`;

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

function chat(restriction: "normal" | "restricted" = "restricted") {
  const root = host(r => r.stores.chat.setState({ activeSessionId: SESSION }));
  restrict(root, restriction);
  const view = render(<BrainUiProvider root={root}><SessionSafety /></BrainUiProvider>);
  return { root, view, list: () => view.container.querySelector<HTMLElement>("[data-google-allowances]") };
}
const revokes = (scope: HTMLElement) => within(scope).queryAllByRole("button").map(button => button.getAttribute("aria-label")).filter(name => name?.startsWith("Revoke"));
const metas = (scope: HTMLElement) => [...scope.querySelectorAll("[data-google-meta]")].map(node => node.textContent);

describe("a restricted chat: Gmail allowances", () => {
  test("GOOGLE_CHAT_RESTRICTED_ONLY: a normal chat reads nothing; the list follows the chat into and out of restriction", async () => {
    const c = chat("normal");
    expect(requests(ALLOWANCES_PATH)).toHaveLength(0);
    restrict(c.root, "restricted");
    expect(requests(ALLOWANCES_PATH)).toHaveLength(1);
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
    expect(c.list()?.getAttribute("data-google-allowances")).toBe("ready");
    restrict(c.root, "normal");
    expect(c.list()).toBeNull();
    // Restricted again: the list opens afresh and reads the host again.
    restrict(c.root, "restricted");
    expect(requests(ALLOWANCES_PATH)).toHaveLength(2);
    expect(c.list()).toBeNull();
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES.slice(2) });
    expect(revokes(c.list()!)).toEqual(["Revoke Save drafts"]);
  });

  test("the read is the owner-only route of this chat; nothing is drawn while it is pending or when it finds none", async () => {
    const c = chat();
    const read = last(ALLOWANCES_PATH);
    expect({ path: read.path, method: read.method, body: read.body }).toEqual({ path: ALLOWANCES_PATH, method: "GET", body: undefined });
    expect(c.list()).toBeNull();
    await read.answer({ allowances: [] });
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
    const post = last(REVOKE_ALLOWANCE_PATH);
    expect({ path: post.path, method: post.method, type: post.type, body: post.body }).toEqual({ path: REVOKE_ALLOWANCE_PATH, method: "POST", type: "application/json", body: { id: "card-ithaca" } });
  });

  test("GOOGLE_CHAT_REFETCH_AFTER_REVOKE: every revoke answer is followed by a fresh read, whose rows the list shows", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
    fireEvent.click(within(c.list()!).getByRole("button", { name: "Revoke Save drafts" }));
    await last(REVOKE_ALLOWANCE_PATH).answer({ revoked: false });
    expect(requests(ALLOWANCES_PATH)).toHaveLength(2);
    // The host's fresh read is what the list shows: here another card has spent changes since.
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES.slice(0, 2).map(row => ({ ...row, remaining_items: 80 })) });
    expect(metas(c.list()!)).toEqual([`80 of ${GOOGLE_SESSION_ALLOWANCE_LIMITS.items} changes left · until 18:02`]);
    expect(c.list()!.querySelector("[role=alert]")).toBeNull();
    fireEvent.click(within(c.list()!).getByRole("button", { name: "Revoke Archive and Mark as read" }));
    await last(REVOKE_ALLOWANCE_PATH).answer({ revoked: true });
    expect(requests(ALLOWANCES_PATH)).toHaveLength(3);
    await last(ALLOWANCES_PATH).answer({ allowances: [] });
    expect(c.list()?.textContent).toContain("Nothing is allowed in this chat.");
  });

  test("a failed revoke keeps the rows and shows the kit's revoke error", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
    fireEvent.click(within(c.list()!).getByRole("button", { name: "Revoke Save drafts" }));
    await last(REVOKE_ALLOWANCE_PATH).fail(new TypeError("Failed to fetch"));
    expect(within(c.list()!).getByRole("alert").textContent).toBe("Failed to fetch");
    expect(revokes(c.list()!)).toHaveLength(2);
  });

  test("GOOGLE_CHAT_HIDDEN: a 404 draws no list", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ error: "Session unavailable." }, 404);
    expect(c.list()).toBeNull();
  });

  test("GOOGLE_CHAT_UNAVAILABLE: a 503 is the kit's unavailable state", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ error: "Google approval storage is temporarily unavailable." }, 503);
    expect(c.list()?.getAttribute("data-google-allowances")).toBe("unavailable");
    expect(c.list()?.textContent).toContain("Allowances for this chat can't be read right now");
  });

  test("any other failure is an error the list shows, and never claims there are none", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ error: "Internal" }, 500);
    expect(within(c.list()!).getByRole("alert").textContent).toBe("Allowances for this chat didn't load. Open the chat again to try again.");
    expect(c.list()!.textContent).not.toContain("Nothing is allowed");
  });

  test("a revoke answered 404 drops the list", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ allowances: ALLOWANCES });
    fireEvent.click(within(c.list()!).getByRole("button", { name: "Revoke Save drafts" }));
    await last(REVOKE_ALLOWANCE_PATH).answer({ error: "Session unavailable." }, 404);
    expect(c.list()).toBeNull();
  });

  test("a card with a change the kit has no words for is not shown, and the list says so", async () => {
    const c = chat();
    await last(ALLOWANCES_PATH).answer({ allowances: [...ALLOWANCES, allowance("card-calendar", "calendar.event.create", "events", 100, UNTIL_2140), allowance("card-drafts", "gmail.modify", "snooze", 3, UNTIL_2140)] });
    expect(revokes(c.list()!)).toEqual(["Revoke Archive and Mark as read"]);
    expect(within(c.list()!).getByRole("alert").textContent).toBe("2 allowances in this chat can't be shown here.");
  });
});

/* ── The host's words and times ────────────────────────────────────────── */

describe("mapping", () => {
  test("GOOGLE_LIMIT_FROM_SOURCE: the per-card budget is the backend's", () => {
    expect(GOOGLE_ALLOWANCE_ITEMS).toBe(GOOGLE_SESSION_ALLOWANCE_LIMITS.items);
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
  });

  test("a card shows the least left and the earliest end any of its rows reports", () => {
    const { grants } = allowanceGrants([allowance("card-a", "gmail.modify", "star", 9, UNTIL_2140), allowance("card-a", "gmail.modify", "archive", 7, UNTIL_1802)], NOW);
    expect(grants).toEqual([{ id: "card-a", address: ODYSSEUS, actions: [{ kind: "star" }, { kind: "archive" }], remaining: 7, limit: 100, until: untilTime(UNTIL_1802, NOW) }]);
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
