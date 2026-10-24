/** Offline C5 fixture: real routes/coordinator/SQLite/stream, deterministic CLI boundary.
 * C6 owns the separate full browser → CLI → Markdown proof. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createUiDb } from "../../../ui-server/src/db/client.js";
import { createPrincipal } from "../../../ui-server/src/db/principals.js";
import { createHygieneReview } from "../../../ui-server/src/inbox/hygiene-review.js";
import { createHygieneReviewRoutes } from "../../../ui-server/src/routes/hygiene-review.js";
import { createInboxAction, INBOX_ACTION_CAP } from "../../../ui-server/src/inbox/actions.js";
import { createInboxStore } from "../../../ui-server/src/inbox/store.js";
import { createInboxStream } from "../../../ui-server/src/inbox/stream.js";
import type { AppEnv } from "../../../ui-server/src/app-env.js";
import type { BrainClient } from "../../../ui-server/src/brain/client.js";
import { parseClientMessage } from "@schlessera/brain-ui-sdk/schemas";

const scratch = mkdtempSync(join(tmpdir(), "c5-server-"));
const db = createUiDb(join(scratch, "ui.sqlite"));
const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 86400 });
// The delegated agent whose private worktree the owner reviews (#2734).
const agent = createPrincipal(db, { authMethod: "delegated", label: "Telemachus research", createdBy: principal.id, ttlSeconds: 86400 });
let as: "owner" | "agent" = "owner";
let details = "details";
let holdDetails: (() => void) | undefined;
const detailReads: string[] = [];
let longPreview = false;
let mode = "",
  category = "broken-link",
  nextCategory = "",
  remaining = 2,
  fingerprint = "b3241252fd85",
  hold: (() => void) | undefined;
const calls: string[][] = [];
let holdNext = false;
/** A host reason override, for long inert worktree reasons (#2837). */
let hostReason: string | undefined;
let releaseNext: (() => void) | undefined;
const reads: Array<{ status: string; pending: boolean }> = [];
const diff = {
  path: "journeys/return-to-ithaca.md",
  before: "[[Eumaios hut]]",
  after: "Eumaios hut",
  changes: [{ line: 14, before: "[[Eumaios hut]]", after: "Eumaios hut" }],
};
// A host-only managed-worktree finding (#2431) as the host's review display
// shapes it: its path is a logical identity, never a brain file.
const worktreeId = "7c1e4a52-3d9b-4f0e-9a61-2b8d5e0c9f13";
function worktreeFinding(n: number) {
  const unknown = category === "managed-worktree";
  return {
    id: `finding-${n}`,
    fingerprint,
    category: "managed-worktree",
    path: `reference-worktree://${worktreeId}`,
    title: unknown
      ? "A managed worktree's work or owner cannot be established"
      : "A released managed worktree still holds unfinished work",
    severity: "warning",
    urgency: null,
    field: null,
    line: null,
    excerpt: `private source · ${unknown ? "work not established" : "14 changed paths"} · released`,
    worktree: { id: worktreeId, domain: "private", state: "released", changedPaths: unknown ? null : 14, removal: null },
    sources: [{ source: "hygiene", name: "managed-worktree", severity: "warning" }],
    priorityReason: { severity: "warning", urgency: "unknown", ageDays: 4, newerWithSameRank: 0, tieBreak: "identity" },
    invalidation: null,
    handlers: unknown
      ? [
          {
            name: "manual",
            kind: "manual",
            input: { type: "none" },
            effect: "Keep it until its state can be established",
            explanation: "Its owner or work could not be established, so it is kept and stays charged. Check again later.",
          },
        ]
      : [
          {
            name: "delete-worktree",
            kind: "choice",
            input: { type: "none" },
            effect: "Delete this worktree and the work it retains",
            explanation: "Removes the worktree, its unfinished files and local commits after rechecking that nothing changed since this preview. Dismissing or snoozing keeps it.",
          },
        ],
  };
}
function finding(n = remaining) {
  if (category.startsWith("managed-worktree")) return worktreeFinding(n);
  return {
    id: `finding-${n}`,
    fingerprint,
    category: category === "manual" ? "silent-edit" : category,
    path: diff.path,
    title:
      category === "required-field"
        ? "A required frontmatter field is missing or invalid"
        : category === "manual"
        ? "Review the silent edit finding"
        : n === 2
        ? "A link points to a note that does not exist"
        : "Another link points to a missing note",
    severity: category === "manual" ? null : "error",
    urgency: null,
    field: category === "required-field" ? "created" : null,
    line: 14,
    excerpt:
      category === "required-field"
        ? null
        : category === "manual"
        ? "Odysseus revised the oar inventory."
        : "…met at [[Eumaios hut]] before…",
    sources:
      category === "manual"
        ? [{ source: "hygiene", name: "silent-edit", severity: null }]
        : category === "required-field"
        ? [{ source: "validation", name: "required-missing", severity: "error" }]
        : [
            { source: "validation", name: "link-unresolved", severity: "error" },
            { source: "audit", name: "broken-link", severity: "error" },
          ],
    priorityReason: {
      severity: category === "manual" ? "unknown" : "error",
      urgency: "unknown",
      ageDays: 12,
      newerWithSameRank: 3,
      tieBreak: "identity",
    },
    invalidation: {
      disposition: "dismissed",
      dispositionOn: "2026-07-02",
      changed: [category === "required-field" ? "value" : category === "manual" ? "evidence" : "tokens"],
    },
    handlers:
      category === "required-field"
        ? [
            {
              name: "required-field",
              kind: "field",
              input: { type: "date", example: "2026-07-12" },
              effect: "Set only created",
              explanation: "Set only created",
            },
          ]
        : category === "manual"
        ? [
            {
              name: "manual",
              kind: "manual",
              input: { type: "none" },
              effect: "Open file",
              explanation: "Review this edit in the file, then check again.",
            },
          ]
        : [
            {
              name: "link-note",
              kind: "choice",
              input: { type: "path" },
              effect: "Link to another note",
              explanation: "Choose an existing note",
            },
            {
              name: "link-text",
              kind: "choice",
              input: { type: "none" },
              effect: "Remove link",
              explanation: "Keep the text",
            },
          ],
  };
}
const brain = {
  hygiene: async (args: string[]) => {
    calls.push(args);
    const op = args[0],
      id = args.at(-1);
    if (op === "next") {
      if (holdNext) await new Promise<void>((resolve) => { releaseNext = resolve; });
      return mode === "blocked"
        ? { blocker: { message: 'unknown key "schemaa" (line 3)' } }
        : {
            finding: remaining ? finding() : null,
            counts: {
              eligibleRemaining: remaining,
              fixed: 0,
              dismissed: 1,
              snoozed: 2,
              nextSnoozeDueAt: "2026-07-13T08:00:00Z",
              informationalNotShown: 3,
            },
          };
    }
    if (op === "list") return { entries: [{ id: `finding-${remaining}`, fingerprint, state: "open", dueAt: null }] };
    if (op === "resolve" && args.includes("--dry-run")) {
      const input = JSON.parse(args[args.indexOf("--input") + 1]);
      if (category === "required-field" && input !== "2026-07-12")
        return {
          id,
          status: "refused",
          reason: "invalid-input",
          fieldError: { field: "created", message: "Use YYYY-MM-DD, for example 2026-07-12." },
        };
      return {
        id,
        status: "preview",
        previewToken: "fixture-preview",
        diff: category.startsWith("managed-worktree")
          ? {
              path: `reference-worktree/${worktreeId}`,
              before: `worktree ${worktreeId}\nprivate source\n14 changed paths since its starting commit\n`,
              after: "",
              changes: [`worktree ${worktreeId}`, "private source", "14 changed paths since its starting commit"].map(
                (line, index) => ({ line: index + 1, before: line, after: "" })
              ),
            }
          : longPreview
          ? {
              ...diff,
              changes: [
                {
                  line: 14,
                  before: "[[Eumaios hut]]",
                  after: Array.from({ length: 20 }, (_, i) => `Eumaeus checks oar ${i + 1}`).join("\n"),
                },
              ],
            }
          : diff,
      };
    }
    if (op === "undo")
      return args.includes("--dry-run")
        ? {
            id,
            status: "preview",
            diff: { ...diff, changes: diff.changes.map((c) => ({ ...c, before: c.after, after: c.before })) },
          }
        : { id, status: "undone" };
    if (op === "check") {
      if (mode === "hold")
        await new Promise<void>((resolve) => {
          hold = resolve;
        });
      if (mode === "check_clear") {
        remaining--;
        return { id, status: "not_detected" };
      }
      return { id, status: "still_detected" };
    }
    if (op === "resolve") {
      if (mode === "hold")
        await new Promise<void>((resolve) => {
          hold = resolve;
        });
      if (mode === "unknown") throw new Error("receipt unavailable");
      // The host's failed removal: no undo, and its fixed code (#2431).
      if (mode === "check_failed" && category.startsWith("managed-worktree"))
        return { id, status: mode, reason: hostReason ?? "The worktree could not be removed; it is kept for review.", code: "cleanup-failed" };
      if (mode === "check_failed_other") return { id, status: "check_failed", reason: "The finding is still detected after removal." };
      if (mode === "refused" && category.startsWith("managed-worktree")) return { id, status: "refused", reason: hostReason ?? "No such repair for this finding." };
      if (["stale", "refused", "check_failed"].includes(mode))
        return {
          id,
          status: mode,
          reason: mode === "refused" ? "the file is locked" : undefined,
          code: mode === "check_failed" ? "link-unresolved" : undefined,
          ...(mode === "check_failed" ? { undoToken: "a".repeat(32) } : {}),
        };
      remaining--;
      if (nextCategory) category = nextCategory;
      return { id, status: "fixed" };
    }
    if (op === "dismiss" || op === "snooze") {
      remaining--;
      return { id, status: op === "dismiss" ? "dismissed" : "snoozed" };
    }
    throw new Error(`unsupported fixture operation: ${op}`);
  },
} as unknown as BrainClient;
let clock = Date.UTC(2026, 6, 12, 9);
const now = () => clock;
/** The recorded facts the host's owner-only read returns (#2734), per fixture mode. */
const SAMPLE = ["src/ledger/olive-oil.ts", "src/ledger/wine-stores.ts", "docs/suitors/antinous-accounts-of-the-great-hall-feasts-in-the-twentieth-year.md", "tests/ledger.test.ts", "package.json"];
function recorded() {
  const facts = {
    owner: { label: "Telemachus research", kind: "agent" as const },
    repository: "github.com/ithaca/palace-ledger", revision: "refs/heads/raft-repairs", commit: "3f9a2c1d4e5b7a8c9d0e1f2a3b4c5d6e7f8a9b0c",
    changedPaths: 14 as number | null, sample: SAMPLE, unverifiedPaths: 2 as number | null, assessedAt: Date.UTC(2026, 6, 12, 14, 2) as number | null,
  };
  if (details === "zero") return { ...facts, changedPaths: 0, sample: [], unverifiedPaths: 0 };
  if (details === "unknown") return { ...facts, owner: null, repository: null, revision: null, commit: null, changedPaths: null, sample: [], unverifiedPaths: null, assessedAt: null };
  if (details === "hostile") return { ...facts, sample: ["[x](http://e.test)<b>y</b>", ...SAMPLE.slice(1)] };
  return facts;
}
const worktrees = {
  owns: () => false,
  run: async (args: string[]) => args[0] === "list" ? { entries: [] } : { finding: null, counts: { eligibleRemaining: 0, fixed: 0, dismissed: 0, snoozed: 0, nextSnoozeDueAt: null, informationalNotShown: 0 } },
  merge: async (cli: unknown) => cli,
  details: async (findingId: string) => {
    detailReads.push(findingId);
    if (details === "hold") await new Promise<void>((resolve) => { holdDetails = resolve; });
    if (details === "fail") throw new Error("details unavailable");
    if (details === "changed" || details === "gone") return { status: details };
    return { status: "details", details: recorded() };
  },
};
const review = createHygieneReview(db, { brain, now, worktrees: worktrees as never });
const store = createInboxStore(db, { now }),
  stream = createInboxStream(store, db, undefined, review.resolver);
const auth = {
  principalId: principal.id,
  expiresAt: principal.expiresAt,
  valid: true,
  retain: () => () => {},
  release() {},
};
const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("principal", (as === "agent" ? agent : principal) as never);
  if (c.req.method === "GET" && c.req.path === "/api/hygiene/review") {
    const r = review.read();
    reads.push({ status: r.review.status, pending: !!r.action });
  }
  await next();
});
app.route("/api", createHygieneReviewRoutes(review));
app.post("/fixture", async (c) => {
  const p = await c.req.json();
  if (p.holdNext !== undefined) holdNext = p.holdNext;
  if (p.as) as = p.as;
  if (p.details) details = p.details;
  if (p.releaseDetails) { holdDetails?.(); holdDetails = undefined; }
  if (p.releaseNext) { holdNext = false; releaseNext?.(); releaseNext = undefined; }
  if (p.longPreview !== undefined) longPreview = p.longPreview;
  if (p.mode !== undefined) mode = p.mode;
  if (p.hostReason !== undefined) hostReason = p.hostReason;
  if (p.category) category = p.category;
  if (p.nextCategory) nextCategory = p.nextCategory;
  if (p.remaining !== undefined) remaining = p.remaining;
  if (p.fingerprint) fingerprint = p.fingerprint;
  if (p.release) {
    hold?.();
    hold = undefined;
  }
  if (p.longFinding) {
    const current = review.read().action;
    if (current) store.commit([{ kind: "hygiene_update", itemId: current.id, expectedVersion: current.version,
      options: current.options, hygiene: { ...current.hygiene!, finding: { ...current.hygiene!.finding,
        title: "Broken link to [[Aeolus]] on the return voyage through the islands and every harbor",
        path: "journeys/return-to-ithaca/" + "long-harbor-name-".repeat(10) + ".md" } } }]);
  }
  if (p.fillActions) {
    for (let i = 0; i < INBOX_ACTION_CAP; i++) {
      const id = `voyage-${i}`, threadId = `voyage-thread-${i}`, at = clock + 1000 + i;
      store.openReviewThread(threadId);
      createInboxAction(db, { id, dedupKey: id, threadId, queue: "actions", type: "choose", status: "pending", version: 1,
        createdAt: at, updatedAt: at, expiresAt: Number.MAX_SAFE_INTEGER,
        payload: { title: "Add Telemachus to the household index", detail: "Review the voyage decision." },
        options: [{ id: "dismiss", label: "Dismiss", effect: { kind: "dismiss" } }] }, [], { now: at });
    }
  }
  if (p.makeRoom) {
    const item = store.getItem("voyage-0");
    if (item?.status === "pending") store.commit([{ kind: "transition", itemId: item.id, expectedVersion: item.version, to: "dismissed" }]);
    clock += 10000;
  }
  if (p.start) await review.command(principal.id, "start");
  return c.json({ calls, read: review.read(), reads, detailReads, selecting: !!releaseNext });
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, s) {
    if (new URL(req.url).pathname === "/ws" && s.upgrade(req)) return;
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "server_hello", protocolRev: 2, capabilities: { inbox: true } }));
    },
    message(ws, raw) {
      const parsed = parseClientMessage(String(raw));
      if (!parsed.ok) throw new Error(parsed.error);
      const msg = parsed.message;
      const ctx = { raw: ws, send: (s: string) => ws.send(s), close: () => ws.close() };
      if (msg.type === "inbox_subscribe") stream.handleSubscribe(ctx as never, msg, auth as never);
      else if (msg.type === "inbox_unsubscribe") stream.handleUnsubscribe(ctx as never, msg);
      else if (msg.type === "inbox_resolve" || msg.type === "inbox_snooze")
        void stream.handleDecision!(ctx as never, msg, auth as never);
    },
    close(ws) {
      stream.dropConnection({ raw: ws } as never);
    },
  },
});
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.port}` }));
process.on("SIGTERM", () => {
  hold?.();
  releaseNext?.();
  holdDetails?.();
  stream.close();
  server.stop(true);
  db.close();
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
});
