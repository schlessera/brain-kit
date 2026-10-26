import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { relative } from "node:path";
import type { ShareIntakeResult } from "@schlessera/brain-ui-sdk/protocol";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import { safeResolve } from "../files/walker.js";
import { isUsablePrincipal, resolvePrincipal, type Principal } from "../db/principals.js";

import { shareContentHash, stageShareAt, type ShareInput } from "../share/staging.js";
import { publishedArrival, stagedArrivalDigest } from "./arrival.js";
import { inboxIntakeWrites, IntakeAuthorizationError } from "./intake-writes.js";
export { IntakeAuthorizationError, IntakeKeyConflictError } from "./intake-writes.js";
import { createProtectedTargetCheck, ProtectedTargetRefusedError } from "../brain/protected-target.js";


/**
 * Refuses a staging directory in a turn's admitted protection set (#2876),
 * named relative to the brain. Absent outside a turn that has one.
 */
type StagingGuard = (path: string) => void;

interface IntakeOutcome { result: ShareIntakeResult; created: boolean; threadId: string; itemId: string }

interface Receipt {
  staging_id: string;
  source: "share" | "cli";
  principal_id: string;
  dedup_key: string;
  content_hash: string;
  state: "preparing" | "committed" | "cleanup";
  result_json: string | null;
}

/** Concrete intake for this UI store. It stages bytes and never dispatches work. */
export function createInboxIntake(db: Database, brainRoot: string, log?: Logger) {
  const write = inboxIntakeWrites(db);
  const active = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;

  function authorize(principal: Principal, isCurrent?: () => boolean): void {
    if (isCurrent && !isCurrent()) throw new IntakeAuthorizationError("Intake turn is no longer authorized");
    const current = resolvePrincipal(db, principal.id);
    if (!current || !isUsablePrincipal(current, Date.now())) throw new IntakeAuthorizationError("Intake credential is no longer usable");
  }
  function committed(key: string): Receipt | null {
    return db.query("SELECT * FROM inbox_intake_receipts WHERE dedup_key = ? AND state = 'committed'").get(key) as Receipt | null;
  }
  async function clean(id: string, guard?: StagingGuard): Promise<void> {
    // safeResolve and server-only UUIDs prevent compensation touching other files.
    for (const name of [id, `.${id}.partial`]) {
      const path = await safeResolve(`${SHARE_STAGING_DIR}/${name}`, brainRoot);
      // A turn's compensation judges each directory as resolved, just before removing it.
      guard?.(relative(realpathSync(brainRoot), path));
      await rm(path, { recursive: true, force: true });
    }
    await write("clean", id);
  }
  async function reconcile(guard?: StagingGuard): Promise<void> {
    const rows = db.query("SELECT staging_id FROM inbox_intake_receipts WHERE state = 'cleanup' OR (state = 'preparing' AND reconcile_after <= ?)").all(Date.now()) as { staging_id: string }[];
    for (const { staging_id: id } of rows) {
      if (active.has(id)) continue;
      await write("reconcile", id, Date.now());
      // Another process may have committed a later row while this sweep awaited
      // cleanup of an earlier one. Never compensate a newly committed receipt.
      const row = db.query("SELECT state FROM inbox_intake_receipts WHERE staging_id = ?").get(id) as { state: string } | null;
      if (row?.state === "cleanup") await clean(id, guard);
    }
  }
  /**
   * `person` marks an arrival a person made through an authenticated route,
   * outside any turn (#2741); a conversation turn's `inbox_add` names that
   * turn, whose host lineage decides what its text could have seen (#2816).
   * Either records provenance with the staged bytes read here; any other
   * arrival records none. A turn's `guard` sees every directory this call
   * stages, publishes or removes, including the compensation of earlier
   * arrivals, before it is changed.
   */
  async function ingest(source: "share" | "cli", input: ShareInput, principal: Principal, explicitKey?: string, isCurrent?: () => boolean,
    author: "person" | { conversationTurn: string } | null = null, guard?: StagingGuard) {
    if (closed) throw new Error("Intake is closed");
    authorize(principal, isCurrent);
    await reconcile(guard);
    const hash = await shareContentHash(input);
    const key = source === "share" ? `share:${hash}` : `cli:${explicitKey}`;
    const existing = committed(key);
    if (existing) { authorize(principal, isCurrent); return write<IntakeOutcome>("replay", existing, hash, principal); }
    const id = crypto.randomUUID();
    // A refused target leaves no receipt to compensate.
    for (const name of [id, `.${id}.partial`]) guard?.(`${SHARE_STAGING_DIR}/${name}`);
    // Journal BEFORE any file write. A killed writer leaves bounded compensation,
    // never a Queue claim. Other live writers get an hour before reconciliation.
    await write("prepare", id, source, principal, key, hash);
    active.add(id);
    let accepted = false;
    try {
      let published: ReadonlyMap<string, Uint8Array> | undefined;
      const result = await stageShareAt(brainRoot, input, id, log, source === "cli" ? "cli" : "web-share-target", files => { published = files; }, guard);
      const binaryHashes = result.skipped?.length ? [] : await Promise.all(input.files.map(async (file, index) => ({ path: result.files[index]?.path, sha256: createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex") })));
      // Evidence of the bytes this process wrote, never a re-read of the
      // published directory; unreadable staging records none.
      const evidence = author && published ? await publishedArrival(id, published).then(stagedArrivalDigest, () => null) : null;
      authorize(principal, isCurrent); // The turn must still own intake at submission.
      const outcome = await write<IntakeOutcome>("accept", id, source, principal, key, hash, result, binaryHashes, evidence, author);
      accepted = outcome.result.id === id;
      if (!accepted) await clean(id, guard);
      return outcome;
    } catch (error) {
      // A committed receipt is never compensated, even if reporting/cleanup fails.
      if (!accepted && committed(key)?.staging_id !== id) {
        await write("compensate", id);
        await clean(id, guard).catch(() => {});
      }
      throw error;
    } finally { active.delete(id); }
  }
  function tracked<T>(operation: () => Promise<T>): Promise<T> {
    const task = operation();
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  }
  return {
    /** A person's share through the authenticated share route. */
    share: (input: ShareInput, principal: Principal) => tracked(() => ingest("share", input, principal, undefined, undefined, "person")),
    cli: (input: ShareInput, key: string, principal: Principal, isCurrent?: () => boolean) => tracked(() => ingest("cli", input, principal, key, isCurrent)),
    /** A person's arrival through the authenticated queue route, outside any turn. */
    person: (input: ShareInput, key: string, principal: Principal) => tracked(() => ingest("cli", input, principal, key, undefined, "person")),
    /**
     * What a hosted conversation's turn adds through `inbox_add`; the server
     * names the turn. With the turn's admitted protection set, every staging
     * effect refuses a protected target as the turn's application does (#2876).
     */
    conversation: (input: ShareInput, key: string, principal: Principal, turnId: string, isCurrent: () => boolean, protectedPaths?: readonly string[]) => {
      const isProtected = protectedPaths ? createProtectedTargetCheck(brainRoot, protectedPaths) : undefined;
      const guard = isProtected && ((path: string) => { if (isProtected(path)) throw new ProtectedTargetRefusedError(); });
      return tracked(() => ingest("cli", input, principal, key, isCurrent, { conversationTurn: turnId }, guard));
    },
    reconcile,
    protectedIds: () => new Set((db.query("SELECT staging_id FROM inbox_intake_receipts WHERE state != 'cleanup'").all() as { staging_id: string }[]).map(row => row.staging_id)),
    close: async () => { closed = true; await Promise.allSettled([...pending]); },
  };
}

export type InboxIntake = ReturnType<typeof createInboxIntake>;
