/**
 * Media in human hygiene review (#2780): Leave pending is a per-pass
 * deferral in review state, and the review's media counts are the ones
 * offline `brain sync` reports. The brain client runs the real offline core
 * CLI directly (no worker boundary), so this suite runs on any host.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { InboxActionItem } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainClient } from "../src/brain/client.js";
import { createUiDb } from "../src/db/client.js";
import { createPrincipal } from "../src/db/principals.js";
import { createHygieneReview } from "../src/inbox/hygiene-review.js";
import { createInboxStore } from "../src/inbox/store.js";

const CORE_CLI = resolve(import.meta.dir, "../../core/src/cli/brain.ts");
const LOOM = "photos/penelope-loom.png", SHIELD = "photos/achilles-shield.jpg";

const clean: Array<() => void> = [];
afterEach(() => { for (const fn of clean.splice(0).reverse()) fn(); });

function run(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(args, { cwd, env: { PATH: process.env.PATH ?? "", HOME: cwd, BRAIN_ROOT: cwd, GIT_CONFIG_NOSYSTEM: "1" } });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}
function put(root: string, path: string, text: string) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "brain-hygiene-media-review-"));
  clean.push(() => rmSync(directory, { force: true, recursive: true }));
  const root = join(directory, "brain"); mkdirSync(root);
  run(root, "git", "init", "-q", "-b", "main");
  put(root, ".gitignore", ".brain/\nbrain.db*\n.brain-index/\n");
  put(root, "brain.config.json", "{}");
  run(root, "git", "add", "-A");
  run(root, "git", "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.test", "commit", "-qm", "fixture");
  put(root, LOOM, "loom bytes"); put(root, SHIELD, "shield bytes");
  const cli = (...args: string[]) => {
    const r = run(root, process.execPath, CORE_CLI, ...args);
    if (![0, 1].includes(r.code ?? -1)) throw new Error(`brain ${args.join(" ")} exited ${r.code}: ${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  const brain = { hygiene: async (args: readonly string[]) => cli("hygiene", "--json", ...args) } as unknown as BrainClient;
  const db = createUiDb(join(directory, "ui.sqlite")); clean.push(() => db.close());
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 86400 });
  return { root, db, principal, brain, cli, review: createHygieneReview(db, { brain }), store: createInboxStore(db) };
}
const path = (item: InboxActionItem | null) => (item?.hygiene?.finding as { path?: string } | undefined)?.path;
const leave = (item: InboxActionItem) => ({ type: "inbox_resolve" as const, itemId: item.id, optionId: "leave-pending" });

test("Leave pending skips a media finding for this pass only, survives refresh and restart, and still counts", async () => {
  const f = setup();
  const first = (await f.review.command(f.principal.id, "start")).action!;
  expect(path(first)).toBe(SHIELD);
  expect(first.options.map(o => o.id)).toEqual(["leave-pending", "check", "later", "dismiss"]);
  expect(f.review.read().review.media).toEqual({ awaitingReview: 2, setAside: 0, kept: 0 });

  await f.review.resolver.resolveAsync(f.principal.id, leave(first));
  const second = f.review.read();
  expect(path(second.action)).toBe(LOOM);
  expect(second.review.deferred).toEqual([{ findingId: first.hygiene!.findingId, fingerprint: first.hygiene!.fingerprint }]);
  expect(f.store.getItem(first.id)).toMatchObject({ status: "snoozed" });
  expect(f.store.getItem(first.id)?.waitUntil).toBeUndefined();
  // Deferral is not a decision: both files still await review, as sync reports.
  expect(second.review.media).toEqual({ awaitingReview: 2, setAside: 0, kept: 0 });
  const synced = await (async () => { const { syncMediaCounts } = await import("../../core/src/lib/media-review.js");
    const { assess } = await import("../../core/src/lib/sync/assess.js"); const { DEFAULT_MEDIA_POLICY } = await import("../../core/src/lib/media.js");
    return syncMediaCounts(f.root, DEFAULT_MEDIA_POLICY, assess(f.root, DEFAULT_MEDIA_POLICY), new Date()); })();
  expect(synced).toEqual({ pending: second.review.media!.awaitingReview, setAside: { dismissed: 0, snoozed: 0, kept: 0 } });
  // The log records nothing for a deferral.
  expect(f.cli("hygiene", "list", "--json").entries.filter((e: { state: string }) => e.state !== "open")).toEqual([]);

  // Same-pass refresh and a restarted server keep the deferral.
  await f.review.command(f.principal.id, "refresh");
  const restarted = createHygieneReview(f.db, { brain: f.brain });
  expect(restarted.read().review.deferred).toHaveLength(1);
  await restarted.resolver.resolveAsync(f.principal.id, leave(restarted.read().action!));
  const done = restarted.read();
  // Everything left pending: the pass ends, and its counts stay truthful.
  expect(done.review.status).toBe("complete");
  expect(done.action).toBeNull();
  expect(done.review.media).toEqual({ awaitingReview: 2, setAside: 0, kept: 0 });
  expect(done.review.counts).toMatchObject({ eligibleRemaining: 0 });

  // A new pass selects them again, reusing the deferred card.
  const again = (await restarted.command(f.principal.id, "start")).action!;
  expect(again.id).toBe(first.id);
  expect(restarted.read().review).toMatchObject({ pass: 2, deferred: [] });
});

test("a deferral lapses within the pass when its finding's fingerprint changes, and not when another file changes", async () => {
  const f = setup();
  const first = (await f.review.command(f.principal.id, "start")).action!;
  expect(path(first)).toBe(SHIELD);
  await f.review.resolver.resolveAsync(f.principal.id, leave(first));
  expect(path(f.review.read().action)).toBe(LOOM);
  // Another file changing leaves the shield deferred: refresh keeps the loom card.
  put(f.root, LOOM, "loom bytes, rewoven");
  await f.review.command(f.principal.id, "refresh");
  expect(path(f.review.read().action)).toBe(LOOM);
  // The shield's own bytes change; leaving the loom pending selects the shield again, in the same pass.
  put(f.root, SHIELD, "shield bytes, repainted");
  await f.review.resolver.resolveAsync(f.principal.id, leave(f.review.read().action!));
  const back = f.review.read();
  expect(back.review).toMatchObject({ status: "active", pass: 1 });
  expect(path(back.action)).toBe(SHIELD);
  expect(back.action!.hygiene!.fingerprint).not.toBe(first.hygiene!.fingerprint);
}, 60_000);
