import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { Logger } from "@opentelemetry/api-logs";
import type { ShareIntakeResult } from "@schlessera/brain-ui-sdk/protocol";
import { SHARE_STAGING_DIR } from "@schlessera/brain-ui-sdk/protocol";
import { removeStagedArrival, StagingTopologyError } from "../share/staging-fs.js";
import { isUsablePrincipal, resolvePrincipal, type Principal } from "../db/principals.js";

import { shareContentHash, stageShareAt, type ShareInput, type StagingWriteGate } from "../share/staging.js";
import { AuthorityHeld, retryHeld, type AuthorityHold } from "../brain/authority-hold.js";
import { publishedArrival, stagedArrivalDigest } from "./arrival.js";
import { inboxIntakeWrites, IntakeAuthorizationError } from "./intake-writes.js";
export { IntakeAuthorizationError, IntakeKeyConflictError } from "./intake-writes.js";
import { createProtectedTargetCheck, ProtectedTargetRefusedError } from "../brain/protected-target.js";


/**
 * Refuses a staging directory in a turn's admitted protection set (#2876),
 * named relative to the brain. Absent outside a turn that has one.
 */
type StagingGuard = (path: string) => void;

/**
 * A conversation turn's write boundary (#2869). A journal observation or a
 * scope pause stops the turn's writes for a while and revokes nothing: every
 * intake write waits for one, bounded and outside any transaction or lock,
 * and runs in the tick its final check passes.
 */
export interface IntakeHolds {
  /** The turn's authority is held, not revoked; its `isCurrent` throws `AuthorityHeld` while it is. */
  hold: AuthorityHold;
  /** A hold that stops brain writes whatever the turn's authority: compensation waits for it alone. */
  writes: AuthorityHold;
  /** The turn's cancellation: it ends every wait. */
  signal: AbortSignal;
}

/** Compensation met a hold it could not wait out: nothing was removed, and its receipt stays queued for reconciliation. */
class CompensationHeld extends Error {
  constructor() { super("Intake cleanup stayed held by a journal observation or a scope pause; its receipt is kept for reconciliation"); this.name = "CompensationHeld"; }
}

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
  /** `run` admits the removal at a turn's write boundary (#2869); without one it runs at once. */
  async function clean(id: string, guard?: StagingGuard, run?: (remove: () => void) => Promise<void>): Promise<void> {
    // Server-only UUIDs and descriptor-anchored, no-follow removal (#2907)
    // keep compensation inside the real staging directory. A turn's
    // compensation judges each directory just before removing it, and never
    // removes during a hold (#2869). A refusal, or a hold it cannot wait out,
    // keeps the receipt for a later, safe retry.
    const remove = () => removeStagedArrival(brainRoot, id, guard);
    if (run) await run(remove); else remove();
    await write("clean", id);
  }
  /**
   * Compensate every abandoned or refused arrival. A linked or changing
   * staging directory refuses with `StagingTopologyError` and keeps the
   * receipt, as a turn's protection refusal does.
   */
  async function reconcile(guard?: StagingGuard, run?: (remove: () => void) => Promise<void>): Promise<void> {
    const rows = db.query("SELECT staging_id FROM inbox_intake_receipts WHERE state = 'cleanup' OR (state = 'preparing' AND reconcile_after <= ?)").all(Date.now()) as { staging_id: string }[];
    for (const { staging_id: id } of rows) {
      if (active.has(id)) continue;
      await write("reconcile", id, Date.now());
      // Another process may have committed a later row while this sweep awaited
      // cleanup of an earlier one. Never compensate a newly committed receipt.
      const row = db.query("SELECT state FROM inbox_intake_receipts WHERE staging_id = ?").get(id) as { state: string } | null;
      if (row?.state !== "cleanup") continue;
      try { await clean(id, guard, run); }
      catch (error) {
        // A held removal stays queued, as every later one does; this sweep is opportunistic.
        if (error instanceof CompensationHeld) return;
        throw error;
      }
    }
  }
  /**
   * The write boundary of one conversation intake (#2869). `gate` admits a
   * change in the tick its final check passes: `stage`, a change of the
   * turn's own authority, waits out a hold, while `compensate`, an inline
   * removal of what it staged, never waits and leaves the removal to its
   * owner. `cleanup` is that owner: it waits for a hold on writes alone,
   * since compensation follows revocation and cancellation too. Every wait
   * shares one deadline across the whole intake. Revocation and cancellation
   * refuse at once; a hold past the bound refuses.
   */
  function writeBoundary(principal: Principal, isCurrent: (() => boolean) | undefined, holds: IntakeHolds) {
    const budget: { deadline?: number } = {};
    const expired = (): never => {
      throw new IntakeAuthorizationError(holds.signal.aborted ? "Intake turn was cancelled; nothing was accepted"
        : "Intake stayed held by a journal observation or a scope pause past the wait bound; nothing was accepted");
    };
    const kept = (): never => { throw new CompensationHeld(); };
    const unheld = <T>(change: () => T | Promise<T>) => { if (holds.writes.active()) throw new AuthorityHeld(); return change(); };
    const gate: StagingWriteGate = async (effect, change) => {
      if (effect === "stage") return retryHeld(holds.hold, holds.signal, () => { authorize(principal, isCurrent); return change(); }, expired, budget);
      if (holds.writes.active()) kept();
      return change();
    };
    return { gate, cleanup: (change: () => void) => retryHeld(holds.writes, holds.signal, () => unheld(change), kept, budget) };
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
    author: "person" | { conversationTurn: string } | null = null, guard?: StagingGuard, holds?: IntakeHolds) {
    if (closed) throw new Error("Intake is closed");
    const boundary = holds && writeBoundary(principal, isCurrent, holds);
    const gate = boundary?.gate;
    /** Runs `change` after the turn's final check; across a hold when the turn has a write boundary. */
    const admitted = <T>(change: () => T | Promise<T>): Promise<T> =>
      gate ? gate("stage", change) : (async () => { authorize(principal, isCurrent); return await change(); })();
    await admitted(() => {});
    await reconcile(guard, gate && (remove => gate("compensate", remove)));
    const hash = await shareContentHash(input);
    const key = source === "share" ? `share:${hash}` : `cli:${explicitKey}`;
    const existing = committed(key);
    if (existing) return admitted(() => write<IntakeOutcome>("replay", existing, hash, principal));
    const id = crypto.randomUUID();
    // A refused target leaves no receipt to compensate.
    for (const name of [id, `.${id}.partial`]) guard?.(`${SHARE_STAGING_DIR}/${name}`);
    // Journal BEFORE any file write. A killed writer leaves bounded compensation,
    // never a Queue claim. Other live writers get an hour before reconciliation.
    await admitted(() => write("prepare", id, source, principal, key, hash));
    active.add(id);
    let owned = false;
    /**
     * Removes this intake's own abandoned arrival, whose receipt is already
     * `cleanup`. With a write boundary the reply does not wait for it: the
     * removal waits for a hold, bounded, and this intake keeps owning the
     * receipt until it settles; one it cannot run stays queued for reconciliation.
     */
    const compensate = (): Promise<void> => {
      if (!boundary) return clean(id, guard);
      owned = true;
      void tracked(() => clean(id, guard, boundary.cleanup).catch(() => {}).finally(() => active.delete(id)));
      return Promise.resolve();
    };
    let accepted = false;
    try {
      let published: ReadonlyMap<string, Uint8Array> | undefined;
      const result = await stageShareAt(brainRoot, input, id, log, source === "cli" ? "cli" : "web-share-target", files => { published = files; }, guard, gate);
      const binaryHashes = result.skipped?.length ? [] : await Promise.all(input.files.map(async (file, index) => ({ path: result.files[index]?.path, sha256: createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex") })));
      // Evidence of the bytes this process wrote, never a re-read of the
      // published directory; unreadable staging records none.
      const evidence = author && published ? await publishedArrival(id, published).then(stagedArrivalDigest, () => null) : null;
      // The turn must still own intake at submission: a hold here waits and
      // checks again, and the receipt commits in the tick that check passes.
      const outcome = await admitted(() => write<IntakeOutcome>("accept", id, source, principal, key, hash, result, binaryHashes, evidence, author));
      accepted = outcome.result.id === id;
      // A losing duplicate's receipt is already `cleanup`.
      if (!accepted) await compensate();
      return outcome;
    } catch (error) {
      // A committed receipt is never compensated, even if reporting/cleanup fails.
      if (!accepted && committed(key)?.staging_id !== id) {
        await write("compensate", id);
        await compensate().catch(() => {});
      }
      throw error;
    } finally { if (!owned) active.delete(id); }
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
    conversation: (input: ShareInput, key: string, principal: Principal, turnId: string, isCurrent: () => boolean, protectedPaths?: readonly string[], holds?: IntakeHolds) => {
      const isProtected = protectedPaths ? createProtectedTargetCheck(brainRoot, protectedPaths) : undefined;
      const guard = isProtected && ((path: string) => { if (isProtected(path)) throw new ProtectedTargetRefusedError(); });
      return tracked(() => ingest("cli", input, principal, key, isCurrent, { conversationTurn: turnId }, guard, holds));
    },
    reconcile,
    /** Startup reconciliation: a refused staging directory keeps its receipts and does not stop the server (#2907). */
    recover: () => reconcile().catch(error => {
      if (!(error instanceof StagingTopologyError)) throw error;
      log?.emit({ severityText: "ERROR", body: "inbox intake reconciliation refused the staging directory", attributes: { error: error.message } });
    }),
    protectedIds: () => new Set((db.query("SELECT staging_id FROM inbox_intake_receipts WHERE state != 'cleanup'").all() as { staging_id: string }[]).map(row => row.staging_id)),
    // An intake's owned cleanup may start as the intake settles: wait for that too.
    close: async () => { closed = true; while (pending.size) await Promise.allSettled([...pending]); },
  };
}

export type InboxIntake = ReturnType<typeof createInboxIntake>;
