/** Offline C5 fixture: real routes/coordinator/SQLite/stream, deterministic CLI boundary.
 * C6 owns the separate full browser → CLI → Markdown proof. With `mediaFlow`,
 * the hygiene routes forward instead to the real media review flow (#2783):
 * an Odysseus brain, the real CLI and the real review server, as its own
 * process (`ui-server/tests/helpers/media-flow.ts`). */
import { createHash } from "node:crypto";
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
import type { MediaFlow } from "../../../ui-server/tests/helpers/media-flow.js";

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
// Media review (#2782): Odysseus's files, planned by a deterministic stand-in
// for `brain hygiene media … --dry-run` and applied by stand-in journal effects.
type MediaFile = {
  id: string; path: string; source: "content" | "scratch"; classes: string[]; bytes: number;
  links: { state: string; conversations: number }; refs: number; refsComplete?: boolean;
  probe?: { width: number | null; height: number | null; durationMs: number | null } | null;
  invalidation?: { disposition: string; dispositionOn: string | null; changed: string[] } | null;
  serve?: "ok" | "404";
};
const MEDIA_DEFAULT: MediaFile[] = [
  { id: "media-harbour-dawn", path: ".brain/scratch/2026-07-11/harbour-dawn.jpg", source: "scratch", classes: ["MEDIA"], bytes: 3_250_586,
    links: { state: "complete", conversations: 2 }, refs: 0, probe: { width: 4032, height: 3024, durationMs: null } },
  { id: "media-ithaca-map", path: "inbox/ithaca-map.png", source: "content", classes: ["MEDIA"], bytes: 2_516_582,
    links: { state: "complete", conversations: 0 }, refs: 2, probe: { width: 2048, height: 1536, durationMs: null } },
];
let mediaFiles: MediaFile[] = MEDIA_DEFAULT;
const mediaDone = new Set<string>();
let mediaKept = 0;
/** Refusals the stand-in plan returns, by `--to`/`--pattern` value or by action. */
let planRefusals: Record<string, Array<Record<string, unknown>>> = {};
let holdPlans = false;
const planHolds: Array<() => void> = [];
/** Told when a plan parks in a hold. */
let parked: (() => void) | undefined;
/** Another device's preview, started by `foreignPreview`. */
let foreign: Promise<unknown> | undefined;
let applyMode = "";
let undoMode = "";
const mediaJournal = new Map<string, { action: string; plan: Record<string, unknown> }>();
const files: string[] = [];
const sha = (seed: string) => createHash("sha256").update(seed).digest("hex");
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
function mediaNext(deferred: Set<string>) {
  return mediaFiles.find((m) => !mediaDone.has(m.id) && !deferred.has(m.id));
}
function mediaFinding(m: MediaFile) {
  const warning = m.classes.includes("LARGE");
  return {
    id: m.id, fingerprint, category: "media", path: m.path, title: "Decide what happens to this media file",
    severity: warning ? "warning" : "info", urgency: null, field: null, line: null, excerpt: null,
    sources: m.classes.map((k) => ({ source: "hygiene", name: `${m.source === "scratch" ? "scratch-" : ""}${k.toLowerCase()}`, severity: k === "LARGE" ? "warning" : "info" })),
    priorityReason: { severity: warning ? "warning" : "info", urgency: "unknown", ageDays: 1, newerWithSameRank: 0, tieBreak: "identity" },
    invalidation: m.invalidation ?? null,
    handlers: [{ name: "manual", kind: "manual", input: { type: "none" }, effect: "Decide in review", explanation: "Decide in review" }],
    media: { source: m.source, classes: m.classes, bytes: m.bytes, sha256: sha(m.path), links: m.links },
  };
}
async function mediaPlan(args: string[], signal?: AbortSignal) {
  const action = args[1]!, id = args[2]!;
  const m = mediaFiles.find((f) => f.id === id);
  if (!m) return { status: "refused", reason: "not-detected" };
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1]! : undefined);
  const to = flag("--to"), pattern = flag("--pattern");
  // A fault, not a refusal: the route answers 409 `preview_refused` (rev 5 §11).
  if (to === "places/throw.png") throw new Error("fixture plan failure");
  if (holdPlans)
    await new Promise<void>((resolve, reject) => {
      planHolds.push(resolve);
      parked?.();
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const linked = m.links.conversations > 0 ? "linked" : m.source === "scratch" && m.links.state !== "complete" ? "unknown" : "unlinked";
  let refusals = planRefusals[pattern ?? to ?? action] ?? [];
  if (action === "persist" && m.source === "scratch") refusals = [{ code: "not-final-location" }];
  if (action === "move" && linked === "linked") refusals = [{ code: "pinned-scratch" }];
  const tracks = action !== "delete";
  const entry = pattern ?? to ?? m.path;
  const base = m.path.slice(m.path.lastIndexOf("/") + 1);
  return {
    status: "preview", id, action, fingerprint,
    premiseDigest: sha(`${action}:${to ?? ""}:${pattern ?? ""}:${fingerprint}`),
    destination: to ?? null,
    files: refusals.length ? [] : [{ path: m.path, role: "source", before: sha(m.path), after: action === "delete" || action === "move" ? null : sha(m.path), bytes: m.bytes },
      ...(to ? [{ path: to, role: "destination", before: null, after: sha(m.path), bytes: m.bytes }] : []),
      ...(tracks ? [{ path: "brain.config.ts", role: "config", before: sha("config"), after: sha(`config+${entry}`), bytes: 512 }] : [])],
    captureBytes: action === "delete" || action === "move" ? m.bytes : 0,
    links: { state: linked, conversations: m.links.conversations },
    references: { complete: m.refsComplete ?? true, count: m.refs },
    rewrites: action === "move" && to && m.refs ? [
      { note: "journeys/return-to-ithaca.md", line: 14, kind: "wiki-embed", before: `![[${base}]]`, after: `![[${to}]]` },
      { note: "places/ithaca.md", line: 3, kind: "wiki-embed", before: `![[${base}]]`, after: `![[${to}]]` },
    ].slice(0, m.refs) : [],
    blockers: [],
    configDiff: tracks ? { path: "brain.config.ts", track: { before: [], after: [entry] }, ignore: { before: [], after: [] } } : null,
    scope: tracks ? (pattern ? "pattern" : "exact") : null,
    pattern: tracks ? entry : null,
    ignoreAdjust: null,
    matches: pattern ? { track: { pattern, anyFolder: !pattern.includes("/"), count: 3, bytes: 4_404_019, changed: 3, ignoredStill: 0, sensitive: 0,
      largest: [{ path: m.path, bytes: m.bytes, before: "ARTIFACT", after: "TRACK" }, { path: "places/map.png", bytes: 1_153_434, before: "ARTIFACT", after: "TRACK" }, { path: "trips/map.png", bytes: 838_861, before: "ARTIFACT", after: "TRACK" }],
      digest: sha(`matches:${pattern}`) }, ignore: null } : null,
    approvalDigest: pattern ? sha(`approval:${pattern}`) : null,
    copy: action === "keep-copy" ? { bytes: m.bytes, sha256: sha(m.path), diskFreeAdvisory: null } : null,
    media: m.probe ?? null,
    resultClass: tracks ? "TRACK" : null,
    refusals,
  };
}
const media = {
  async apply(request: { id: string; findingId: string; plan: { action: string; destination: string | null; files: Array<{ path: string; role: string }> } }) {
    calls.push(["media-apply", request.plan.action, request.plan.destination ?? ""]);
    const { action } = request.plan, source = mediaFiles.find((f) => f.id === request.findingId)!;
    mediaJournal.set(request.id, { action, plan: request.plan });
    const none = { available: false };
    if (applyMode === "stale") return { journalId: request.id, action, outcome: "stale", reason: "stale", files: [], undo: none };
    if (applyMode === "capacity") return { journalId: request.id, action, outcome: "refused", reason: "capture-capacity", refusals: [{ code: "capture-capacity" }], files: [], undo: none };
    if (applyMode === "partial")
      return { journalId: request.id, action, outcome: "partial", reason: "interrupted", files: [{ path: "places/ithaca.md", state: "conflict" }, { path: source.path, state: "restored" }], undo: none };
    if (applyMode === "compensated")
      return { journalId: request.id, action, outcome: "compensated", reason: "copy stopped at 1.9 of 3.1 MB (server restarted)",
        files: [{ path: request.plan.destination ?? source.path, state: "removed" }, { path: "brain.config.ts", state: "unchanged" }], undo: none };
    mediaDone.add(request.findingId);
    if (action === "keep-copy") mediaKept++;
    return { journalId: request.id, action, outcome: action === "keep-copy" ? "kept" : "applied",
      files: request.plan.files.map((f) => ({ path: f.path, state: f.role === "source" && (action === "move" || action === "delete") ? "removed" : f.role === "source" ? "unchanged" : "created" })),
      ...(action === "keep-copy" ? { copySha256: sha(source.path) } : {}), undo: none };
  },
  async undo(request: { id: string; sourceId: string }) {
    calls.push(["media-undo", request.sourceId]);
    const source = mediaJournal.get(request.sourceId)!;
    if (undoMode === "evicted")
      return { journalId: request.sourceId, action: source.action, outcome: "refused", reason: "rollback-evicted", files: [], undo: { available: false, reason: "rollback-evicted" } };
    return { journalId: request.id, action: source.action, outcome: "undone", files: [], undo: { available: false, reason: "already-undone" } };
  },
  receipt(id: string) {
    const source = mediaJournal.get(id);
    return source ? { journalId: id, action: source.action, outcome: source.action === "keep-copy" ? "kept" : "applied", files: [], undo: { available: false, reason: undoMode || "rollback-evicted" } } : null;
  },
  async recover() {},
};
function deferredOf(args: string[]) {
  const at = args.indexOf("--defer");
  return new Set(at >= 0 ? args[at + 1]!.split(",").map((d) => d.split("=")[0]!) : []);
}
const brain = {
  hygiene: async (args: string[], opts?: { signal?: AbortSignal }) => {
    calls.push(args);
    const op = args[0],
      id = args.at(-1);
    if (op === "media") return mediaPlan(args, opts?.signal);
    if (op === "next" && category === "media") {
      if (holdNext) await new Promise<void>((resolve) => { releaseNext = resolve; });
      const deferred = deferredOf(args);
      const at = args.indexOf("--finding");
      const m = at >= 0 ? mediaFiles.find((f) => f.id === args[at + 1]) : mediaNext(deferred);
      const open = mediaFiles.filter((f) => !mediaDone.has(f.id));
      return {
        finding: m && !mediaDone.has(m.id) ? mediaFinding(m) : null,
        counts: { eligibleRemaining: open.filter((f) => !deferred.has(f.id)).length, fixed: mediaDone.size - mediaKept, dismissed: 0, snoozed: 0,
          nextSnoozeDueAt: null, informationalNotShown: 0, kept: mediaKept },
        media: { awaitingReview: open.length, setAside: 0, kept: mediaKept, links: { state: "complete", observed: 1, limit: 5000, tooLarge: false, symlinks: 0 } },
      };
    }
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
const review = createHygieneReview(db, { brain, now, worktrees: worktrees as never, media: media as never });
// A second owner device, whose running preview makes this one's `preview-busy` (rev 4 §3.3).
const penelope = createPrincipal(db, { authMethod: "password", label: "Penelope tablet", ttlSeconds: 86400 });
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
/** The real media review flow, when a scene asked for it: its JSON routes answer for this fixture's. */
let flow: MediaFlow | undefined;
app.use("/api/hygiene/*", async (c, next) => {
  if (!flow) return next();
  const body = c.req.method === "GET" ? undefined : await c.req.text();
  const r = await fetch(`${flow.url}${c.req.path}`, { method: c.req.method, headers: { "content-type": "application/json", "x-media-flow-principal": "owner" }, ...(body ? { body } : {}) });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
});
app.use("*", async (c, next) => {
  c.set("principal", (as === "agent" ? agent : principal) as never);
  if (c.req.method === "GET" && c.req.path === "/api/hygiene/review") {
    const r = review.read();
    reads.push({ status: r.review.status, pending: !!r.action });
  }
  await next();
});
app.route("/api", createHygieneReviewRoutes(review));
// The authenticated raw files route's stand-in: every request is logged, nothing is cached.
app.get("/api/files/content", (c) => {
  const path = c.req.query("path") ?? "";
  files.push(path);
  const m = mediaFiles.find((f) => f.path === path);
  if (!m || m.serve === "404") return c.json({ error: "not_found" }, 404);
  const ext = path.slice(path.lastIndexOf(".") + 1);
  const type = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "mp4" ? "video/mp4" : "application/octet-stream";
  return new Response(ext === "mp4" ? new Uint8Array(64) : PNG, { headers: { "content-type": type, "cache-control": "no-store" } });
});
/**
 * Answer every request a hold is keeping open, and stop holding new ones. The
 * browser command's `stop` waits for every forwarded request before it sends
 * SIGTERM, so teardown calls this first: a test that fails while a request is
 * held then reports its own assertion instead of a hook timeout (#3665).
 */
function releaseHolds() {
  holdPlans = false;
  holdNext = false;
  if (mode === "hold") mode = "";
  if (details === "hold") details = "details";
  for (const release of planHolds.splice(0)) release();
  hold?.();
  hold = undefined;
  releaseNext?.();
  releaseNext = undefined;
  holdDetails?.();
  holdDetails = undefined;
}
app.post("/fixture", async (c) => {
  const p = await c.req.json();
  if (p.releaseAll) releaseHolds();
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
  if (p.mediaFiles) { mediaFiles = p.mediaFiles === "default" ? MEDIA_DEFAULT : p.mediaFiles; mediaDone.clear(); mediaKept = 0; }
  if (p.planRefusals) planRefusals = p.planRefusals;
  if (p.holdPlans !== undefined) holdPlans = p.holdPlans;
  if (p.releasePlans) {
    holdPlans = false; for (const release of planHolds.splice(0)) release();
    // The other device's preview has finished, and freed the scan, when this answers.
    await foreign; foreign = undefined;
  }
  if (p.applyMode !== undefined) applyMode = p.applyMode;
  if (p.undoMode !== undefined) undoMode = p.undoMode;
  if (p.foreignPreview) {
    const current = review.read().action!;
    holdPlans = true;
    const inPlan = new Promise<void>((resolve) => { parked = resolve; });
    foreign = review.preview(penelope.id, { itemId: current.id, optionId: "media-delete", expectedVersion: current.version, input: null }).catch(() => {});
    // Its scan is running once its plan parks in the hold (or it ended without one).
    await Promise.race([inPlan, foreign]);
    parked = undefined;
  }
  if (p.start) await review.command(principal.id, "start");
  // The real media flow (#2783): boot it, then read its bytes, counts and remote, or kill and boot it again.
  const result: Record<string, unknown> = {};
  if (p.mediaFlow) {
    if (flow) throw new Error("media flow already running");
    // Loaded only for a flow scene: every other scene starts and stops as before.
    const { createMediaFlow } = await import("../../../ui-server/tests/helpers/media-flow.js");
    flow = createMediaFlow(p.mediaFlow);
    await flow.boot();
    if (p.mediaFlow.start !== false) await flow.command("start");
  }
  if (flow && p.flowRestart) { const port = Number(new URL(flow.url).port); await flow.kill(); await flow.boot({ port }); }
  if (flow && p.flowParity) result.parity = await flow.parity({ sync: p.flowParity === "sync", eligibility: !!p.flowEligibility });
  if (flow && p.flowBytes) { result.bytes = flow.bytes(); result.texts = Object.fromEntries((p.flowBytes === true ? [] : p.flowBytes as string[]).map(path => [path, flow!.text(path)])); }
  if (flow && p.flowRemote) result.remote = flow.remoteFiles();
  if (flow && p.flowRead) result.flowRead = await flow.read();
  return c.json({ calls, read: review.read(), reads, detailReads, selecting: !!releaseNext, files, flow: flow ? { url: flow.url, ...result } : null });
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
  releaseHolds();
  stream.close();
  server.stop(true);
  db.close();
  rmSync(scratch, { recursive: true, force: true });
  if (!flow) process.exit(0);
  void flow.close().finally(() => process.exit(0));
});
