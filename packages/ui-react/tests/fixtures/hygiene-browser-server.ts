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
import { createInboxStore } from "../../../ui-server/src/inbox/store.js";
import { createInboxStream } from "../../../ui-server/src/inbox/stream.js";
import type { AppEnv } from "../../../ui-server/src/app-env.js";
import type { BrainClient } from "../../../ui-server/src/brain/client.js";
import { parseClientMessage } from "@schlessera/brain-ui-sdk/schemas";

const scratch = mkdtempSync(join(tmpdir(), "c5-server-"));
const db = createUiDb(join(scratch, "ui.sqlite"));
const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 86400 });
let longPreview = false;
let mode = "",
  category = "broken-link",
  nextCategory = "",
  remaining = 2,
  fingerprint = "b3241252fd85",
  hold: (() => void) | undefined;
const calls: string[][] = [];
const diff = {
  path: "journeys/return-to-ithaca.md",
  before: "[[Eumaios hut]]",
  after: "Eumaios hut",
  changes: [{ line: 14, before: "[[Eumaios hut]]", after: "Eumaios hut" }],
};
function finding(n = remaining) {
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
    if (op === "next")
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
        diff: longPreview
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
    if (op === "check") return { id, status: "still_detected" };
    if (op === "resolve") {
      if (mode === "hold")
        await new Promise<void>((resolve) => {
          hold = resolve;
        });
      if (mode === "unknown") throw new Error("receipt unavailable");
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
const now = () => Date.UTC(2026, 6, 12, 9);
const review = createHygieneReview(db, { brain, now });
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
  c.set("principal", principal as never);
  await next();
});
app.route("/api", createHygieneReviewRoutes(review));
app.post("/fixture", async (c) => {
  const p = await c.req.json();
  if (p.longPreview !== undefined) longPreview = p.longPreview;
  if (p.mode !== undefined) mode = p.mode;
  if (p.category) category = p.category;
  if (p.nextCategory) nextCategory = p.nextCategory;
  if (p.remaining !== undefined) remaining = p.remaining;
  if (p.fingerprint) fingerprint = p.fingerprint;
  if (p.release) {
    hold?.();
    hold = undefined;
  }
  if (p.start) await review.command(principal.id, "start");
  return c.json({ calls, read: review.read() });
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
  stream.close();
  server.stop(true);
  db.close();
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
});
