import { registerTurnJournalGoogleDom, unregisterTurnJournalGoogleDom } from "./turn-journal-google-dom.js";
registerTurnJournalGoogleDom();
import { afterAll, afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { JournalGoogleAction, JournalOutwardAction, TurnJournalDetails, TurnJournalSummary } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { TurnJournal } from "../../src/components/chat/turn-journal.js";

// The turn journal's two Google classes (#4216): reversible calls in their own
// section, irreversible ones with the outward receipts in the operation's words.
const turnId = "odysseus-journal", sessionId = "ithaca", draft = "r-8f2c41d9e0b7a6c5";
const summary: TurnJournalSummary = { state: "complete", changedFiles: 0, steeringFiles: 0, keptFiles: 0, costUsd: null, costIsEstimate: null, profile: "governed", actor: "interactive", model: null, policyHash: null, observedAt: Date.UTC(2026, 6, 12) };
const reversible = (id: number, operation: string, decision: JournalGoogleAction["decision"], target: string | null, tainted = false, admission: JournalGoogleAction["admission"] = null): JournalGoogleAction =>
  ({ id, at: summary.observedAt!, callId: `call-${id}`, tool: "brain_google_gmail", operation, effect: "reversible", target, tainted, decision, admission, revertible: false, undoAvailable: false });
const outward = (id: number, decision: JournalOutwardAction["decision"], target: string | null, operation?: string): JournalOutwardAction =>
  ({ id, at: summary.observedAt!, tool: operation ? "brain_google_gmail" : "Bash", action: operation ? "google_write" : "git_push", target, decision, historyRewrite: false, revertible: false, ...(operation ? { google: { callId: `call-${id}`, operation, effect: "irreversible" as const } } : {}) });

const roots: BrainUiRoot[] = [];
afterEach(() => { cleanup(); for (const root of roots.splice(0)) root.dispose(); });
afterAll(unregisterTurnJournalGoogleDom);

async function journal(extra: Partial<TurnJournalDetails>) {
  const details: TurnJournalDetails = { turnId, sessionId, summary, changes: [], missing: [], ...extra };
  const root = createBrainUiRoot({ storage: null, request: async input => {
    const path = new URL(String(input), "http://localhost/").pathname;
    if (path.endsWith("/journal")) return Response.json(details);
    if (path.endsWith("/plan")) return Response.json({ turnId, action: "revert", paths: [] });
    if (path.endsWith("/revert")) return Response.json({ receipt: null });
    throw new Error(`Unexpected journal request: ${path}`);
  } });
  roots.push(root);
  root.stores.chat.getState().setActiveSession(sessionId);
  const view = render(<BrainUiProvider root={root}><TurnJournal turnId={turnId} summary={summary} /></BrainUiProvider>);
  fireEvent.click(view.getByRole("button", { name: /changed file/ }));
  await waitFor(() => expect(view.getByRole("heading", { name: "What changed" })).toBeTruthy());
  const rows = (heading: string) => [...view.getByRole("heading", { name: heading }).closest("section")!.querySelectorAll("li")].map(li => li.textContent);
  return { view, rows };
}

test("reversible calls get their own section, ahead of the irreversible outward receipts", async () => {
  const { view, rows } = await journal({
    googleActions: [reversible(1, "gmail.modify", "allowed", "gmail.modify", true, "session_allowance"), reversible(2, "gmail.draft.save", "approved", draft)],
    outwardActions: [outward(3, "approved", draft, "gmail.draft.send"), outward(4, "refused", "gmail.trash", "gmail.trash"), outward(5, "approved", "github.com/odysseus/voyage.git")],
  });
  const headings = [...view.container.querySelectorAll("h3")].map(h => h.textContent);
  expect(headings.indexOf("Reversible Google calls"), "REVERSIBLE_SECTION_SHOWN").toBeGreaterThan(-1);
  expect(headings.indexOf("Reversible Google calls"), "REVERSIBLE_BEFORE_OUTWARD").toBeLessThan(headings.indexOf("Outward actions"));
  expect(rows("Reversible Google calls")).toEqual([
    "Gmail label change · Allowed for this chatReview recommended: the chat had read text other people wrote.",
    `Gmail draft save · Approved on its card · ${draft}`,
  ]);
  expect(rows("Outward actions"), "OUTWARD_GOOGLE_OPERATION_WORDS").toEqual([
    `Gmail send · Approved · ${draft}`,
    "Gmail trash · Refused",
    "Git push · Approved · github.com/odysseus/voyage.git",
  ]);
  expect(view.queryByRole("button", { name: /Revert|Undo/ }), "GOOGLE_ROWS_HAVE_NO_REVERT").toBeNull();
});

test("an operation outside the five reads Google call plus its id in mono", async () => {
  const { view, rows } = await journal({ outwardActions: [outward(1, "policy_allowed", "evt-penelope", "calendar.event.delete")] });
  expect(rows("Outward actions")).toEqual(["Google call calendar.event.delete · Allowed by policy · evt-penelope"]);
  expect(view.container.querySelector("[data-google-operation-id]")?.className).toContain("font-mono");
});

test("a Google receipt without operation facts keeps the generic words and its target", async () => {
  const legacy: JournalOutwardAction = { ...outward(1, "approved", "gmail.trash", "gmail.trash"), google: undefined };
  const unresolved: JournalOutwardAction = { ...outward(2, "declined", null, "gmail.draft.send") };
  const { rows } = await journal({ outwardActions: [legacy, unresolved] });
  expect(rows("Outward actions")).toEqual(["Google write · Approved · gmail.trash", "Gmail send · Declined · Destination unresolved"]);
});

test("no reversible calls draws no reversible section; a truncated list says so", async () => {
  const empty = await journal({ googleActions: [], outwardActions: [outward(1, "approved", draft, "gmail.draft.send")] });
  expect(empty.view.queryByRole("heading", { name: "Reversible Google calls" }), "EMPTY_REVERSIBLE_HIDDEN").toBeNull();
  cleanup();
  const truncated = await journal({ googleActions: [reversible(1, "gmail.modify", "declined", "gmail.modify")], googleActionsTruncated: true });
  expect(truncated.view.getByText("Showing the first 1,000 reversible Google calls. More remain in the retained governance records.")).toBeTruthy();
  expect(truncated.rows("Reversible Google calls")).toEqual(["Gmail label change · Declined"]);
});
