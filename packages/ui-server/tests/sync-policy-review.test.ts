/**
 * A sync whose pull changes the governance policy opens a host-owned review
 * instead of failing (#4256). The route publishes nothing itself: the review
 * goes through the real policy writer, and only the owner's approval writes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { parseGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import type { AppEnv } from "../src/app-env.js";
import type { Principal } from "../src/db/principals.js";
import { createUiDb } from "../src/db/client.js";
import { createPolicyProposals } from "../src/brain/policy-proposal.js";
import { createOwnerPolicyReviews, OwnerPolicyReviewError, type OwnerPolicyJournal } from "../src/brain/owner-policy-reviews.js";
import { createBrainRoutes } from "../src/routes/brain";
import { createActivityStore } from "../src/activity/store.js";
import type { Logger, LogRecord } from "@opentelemetry/api-logs";
import type { BrainClient } from "../src/brain/client";
import type { HostBoundary, StreamingExecution } from "../src/brain/host-boundary";
import type { KeytermSettings } from "../src/voice/keyterm-builder";

const CURRENT = `---
schema_version: 1
# Odysseus keeps outward writes closed.
---
Odysseus decides what leaves Ithaca.
`;
const INCOMING = `---
schema_version: 1
# Odysseus keeps outward writes closed.
outward:
  github:
    repositories: [ithaca/*]
---
Odysseus decides what leaves Ithaca.
`;
const UPSTREAM = "4b1d0c0ffee4b1d0c0ffee4b1d0c0ffee4b1d0c0";
const owner = { id: "p-penelope", kind: "owner" } as Principal;
const suitor = { id: "p-antinous", kind: "owner" } as Principal;

const cleanup: (() => void)[] = [];
afterEach(() => { for (const step of cleanup.splice(0).reverse()) step(); });

function brain() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-sync-policy-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "context/policies"), { recursive: true });
  writeFileSync(join(root, "context/policies/governance.md"), CURRENT);
  return root;
}

function failedProcess(): StreamingExecution {
  const encoder = new TextEncoder();
  return {
    stdout: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode("Pulled 1 commit\n")); controller.close(); } }),
    stderr: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode("Sync paused before publishing anything\n")); controller.close(); } }),
    exited: Promise.resolve(1), signalCode: null, kill() {},
  };
}

/** The real policy writer behind the sync's host-owned reviews, with a journal that admits a write only in a begun user window. */
function setup(root: string, launch?: HostBoundary["launch"]) {
  const db = createUiDb(":memory:"); cleanup.push(() => db.close());
  const active = new Set<string>(), windows: string[] = [];
  const journal: OwnerPolicyJournal = {
    async begin(turnId, metadata) { expect(metadata.actor).toBe("user"); active.add(turnId); windows.push(turnId); },
    async finish(turnId) { active.delete(turnId); },
  };
  const events: unknown[] = [];
  const proposals = createPolicyProposals({ root, db, lock: createKeyedLock(),
    observeUserPolicy: (turnId, write) => { if (!active.has(turnId)) throw new Error("approved policy write requires an active user window"); write(); },
    recordEvent: review => { events.push(review); } });
  const reviews = createOwnerPolicyReviews({ root, proposals, journal, authorized: id => id === owner.id || id === suitor.id,
    turnPrefix: "sync-policy", requestPrefix: "sync", fail: (status, code, message) => new OwnerPolicyReviewError(status, code, message) });
  cleanup.push(() => reviews.close());
  let launched = 0;
  const store = createActivityStore(db);
  const logs: LogRecord[] = [];
  const log = { emit: (record: LogRecord) => { logs.push(record); }, enabled: () => true } as unknown as Logger;
  const routes = createBrainRoutes({ activity: store, log,
    brainPath: root, brain: { cliCommand: () => [process.execPath, "sync.ts"] } as BrainClient,
    keyterms: { brainPath: root } as KeytermSettings, exec: {}, policyReviews: reviews,
    boundary: { launch: launch ?? (async execution => {
      launched++;
      execution.onExecute?.();
      execution.onPolicyChange?.({ content: new TextEncoder().encode(INCOMING), upstream: UPSTREAM });
      return failedProcess();
    }) } as HostBoundary,
  });
  const as = (principal: Principal) => new Hono<AppEnv>().use("*", async (c, next) => { c.set("principal", principal); await next(); }).route("/api", routes);
  const family = (turnPrefix: string, requestPrefix: string) => createOwnerPolicyReviews({ root, proposals, journal, authorized: () => true,
    turnPrefix, requestPrefix, fail: (status, code, message) => new OwnerPolicyReviewError(status, code, message) });
  return { as, windows, events, launched: () => launched, family, store, logs };
}

const frames = async (response: Response) => (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
const decide = (app: Hono<AppEnv>, review: { turn_id?: unknown; request_id?: unknown }, approve: boolean) => app.request(`/api/brain/sync/policy/${review.turn_id}/${review.request_id}`,
  { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost" }, body: JSON.stringify({ approve }) });

describe("a sync's incoming policy change (#4256)", () => {
  test("streams a review of the exact incoming bytes and ends paused, writing nothing", async () => {
    const root = brain();
    const { as } = setup(root);
    const all = await frames(await as(owner).request("/api/brain/sync", { method: "POST" }));
    const review = all.find(frame => frame.type === "policy_review");
    expect(review, "SYNC_STREAMS_POLICY_REVIEW").toBeDefined();
    expect(String(review!.turn_id)).toStartWith("sync-policy-");
    const shown = review!.review as { state: string; rationale: string; frontmatterDiff: string };
    expect(shown.state).toBe("pending");
    expect(shown.rationale).toContain(UPSTREAM.slice(0, 12));
    expect(shown.frontmatterDiff).toContain("+ outward:");
    expect(all.at(-1), "SYNC_ENDS_PAUSED").toMatchObject({ type: "done", success: false, reason: "policy_review" });
    expect(readFileSync(join(root, "context/policies/governance.md"), "utf8"), "NOTHING_WRITTEN_BEFORE_APPROVAL").toBe(CURRENT);
  });

  test("a paused sync's Activity run is not a failure, and nothing logs a sync failure", async () => {
    const root = brain();
    const { as, store, logs } = setup(root);
    await frames(await as(owner).request("/api/brain/sync", { method: "POST" }));
    const span = store.changesSince(0).flatMap(change => change.kind === "span" ? [change.span] : []).find(span => span.jobName === "ui-sync")!;
    const ended = store.getSpan(span.spanId)!;
    expect(ended.outcome, "PAUSED_RUN_NOT_FAILED").toBe("cancelled");
    expect(ended.outcomeReason ?? "", "PAUSED_RUN_NAMES_REVIEW").toContain("Paused for the owner's review");
    expect(logs.some(record => record.body === "ui sync failed"), "PAUSED_NOT_LOGGED_AS_FAILURE").toBe(false);
    expect(logs.some(record => record.body === "ui sync paused for policy review")).toBe(true);
  });

  test("approval writes exactly the incoming bytes through the policy writer, in a user window", async () => {
    const root = brain();
    const { as, windows, events } = setup(root);
    const review = (await frames(await as(owner).request("/api/brain/sync", { method: "POST" }))).find(frame => frame.type === "policy_review")!;
    const answered = await decide(as(owner), review, true);
    expect(answered.status).toBe(200);
    expect((await answered.json()).state, "APPROVED_REVIEW_WRITTEN").toBe("updated");
    expect(readFileSync(join(root, "context/policies/governance.md"), "utf8"), "INCOMING_BYTES_ADOPTED").toBe(INCOMING);
    expect(windows).toEqual([String(review.turn_id)]);
    expect(events).toHaveLength(1);
    const policy = parseGovernancePolicy(readFileSync(join(root, "context/policies/governance.md")));
    expect(policy.ok).toBe(true);
    expect(policy.effective.outward.github.repositories, "NEXT_TURN_POLICY_ADMITS_REPOSITORY").toEqual(["ithaca/*"]);
  });

  test("declining writes nothing, and the next sync opens the review again", async () => {
    const root = brain();
    const { as, launched } = setup(root);
    const review = (await frames(await as(owner).request("/api/brain/sync", { method: "POST" }))).find(frame => frame.type === "policy_review")!;
    expect((await (await decide(as(owner), review, false)).json()).state).toBe("declined");
    expect(readFileSync(join(root, "context/policies/governance.md"), "utf8"), "DECLINE_WRITES_NOTHING").toBe(CURRENT);
    const again = await frames(await as(owner).request("/api/brain/sync", { method: "POST" }));
    expect(again.some(frame => frame.type === "policy_review"), "NEXT_SYNC_REVIEWS_AGAIN").toBe(true);
    expect(launched()).toBe(2);
  });

  test("unanswered reviews never fill the cap: each sync's review replaces the owner's older one", async () => {
    const root = brain();
    const { as } = setup(root);
    const reviews: Record<string, unknown>[] = [];
    for (let i = 0; i < 6; i++) {
      const all = await frames(await as(owner).request("/api/brain/sync", { method: "POST" }));
      const review = all.find(frame => frame.type === "policy_review");
      expect(review, `SYNC_${i}_REVIEWS_AGAIN: ${JSON.stringify(all.at(-1))}`).toBeDefined();
      reviews.push(review!);
    }
    // The superseded reviews were declined: answering one now returns its recorded receipt and writes nothing.
    expect((await (await decide(as(owner), reviews[0]!, true)).json()).state, "SUPERSEDED_REVIEW_DECLINED").toBe("declined");
    expect(readFileSync(join(root, "context/policies/governance.md"), "utf8")).toBe(CURRENT);
    expect((await (await decide(as(owner), reviews.at(-1)!, true)).json()).state, "CURRENT_REVIEW_APPROVES").toBe("updated");
  });

  test("another principal or an unknown review is refused, and nothing is written", async () => {
    const root = brain();
    const { as, family } = setup(root);
    const review = (await frames(await as(owner).request("/api/brain/sync", { method: "POST" }))).find(frame => frame.type === "policy_review")!;
    const other = await decide(as(suitor), review, true);
    expect(other.status, "OTHER_PRINCIPAL_REFUSED").toBe(404);
    const unknown = await decide(as(owner), { turn_id: "sync-policy-unknown", request_id: "sync-unknown" }, true);
    expect(unknown.status, "UNKNOWN_REVIEW_REFUSED").toBe(404);
    // A recorded review of another family (Settings) is never read or answered through the sync route.
    const settings = family("settings-apify", "apify");
    cleanup.push(() => settings.close());
    const opened = await settings.propose(owner.id, () => INCOMING, undefined, "Settings change", "invalid");
    await settings.decide(owner.id, opened.turn_id, opened.request_id, false);
    const foreign = await decide(as(owner), opened, true);
    expect(foreign.status, "FOREIGN_REVIEW_FAMILY_REFUSED").toBe(404);
    expect(readFileSync(join(root, "context/policies/governance.md"), "utf8")).toBe(CURRENT);
  });

  test("an incoming policy that does not validate fails the sync with next steps and opens no review", async () => {
    const root = brain();
    const { as, logs } = setup(root, async execution => {
      execution.onExecute?.();
      execution.onPolicyChange?.({ content: new TextEncoder().encode("---\nschema_version: 99\n---\n"), upstream: null });
      return failedProcess();
    });
    const all = await frames(await as(owner).request("/api/brain/sync", { method: "POST" }));
    expect(all.some(frame => frame.type === "policy_review"), "INVALID_OPENS_NO_REVIEW").toBe(false);
    expect(all.some(frame => frame.type === "progress" && String(frame.text).includes("Revert the upstream commit")), "INVALID_NAMES_NEXT_STEP").toBe(true);
    const failed = logs.find(record => record.body === "ui sync failed");
    expect(String(failed?.attributes?.error), "INVALID_RUN_RECORDS_REAL_CAUSE").toContain("did not validate");
    expect(all.at(-1)).toMatchObject({ type: "done", success: false });
    expect(readFileSync(join(root, "context/policies/governance.md"), "utf8")).toBe(CURRENT);
  });
});
