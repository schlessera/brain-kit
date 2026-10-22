/**
 * Shared reference source (#2429): authorized acquisition, request-only
 * refresh and capacity eviction over the native reference pool.
 *
 * - Domains. A revision is public only when the anonymous transport resolves
 *   it; public source is shared host-wide and is only ever fetched
 *   anonymously. Everything else is private to one principal of this brain
 *   and needs a live covering grant (docs/decisions/reference-source-grants.md).
 * - Clocks. Authority validation and source freshness are separate. A request
 *   after `validationMs` re-checks the exact published commit; a request after
 *   `refreshMs` since the last successful refresh fetches. Nothing runs on a
 *   timer.
 * - Publication. A complete, sealed root is published into its domain's view;
 *   readers bound to the view see it on their next path read.
 * - Admission. At most `operations` acquisitions or refreshes run host-wide.
 *   Requests for the same source in the same domain join one operation, and a
 *   bounded queue waits for the rest.
 * See docs/decisions/reference-source-acquisition.md.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { createNativeBrainManagerClient, NativePoolRecord } from "@schlessera/brain-ui-sdk/internal";
import type { Logger } from "@opentelemetry/api-logs";
import { coveringReferenceGrant, isLiveReferenceGrant, referenceRepository, type ReferenceGrant, type ReferenceRepository } from "../db/reference-grants.js";
import { referenceRevision, ReferenceTransportError, type ReferenceTransport } from "./reference-transport.js";

type Client = ReturnType<typeof createNativeBrainManagerClient>;
export type ReferencePool = Pick<Client, "poolStatus" | "poolCreate" | "poolSeal" | "poolRelease" | "poolPublish" | "poolUnpublish" | "poolWithdraw" | "listPoolRecovery">;

export interface ReferenceSourceLimits {
  /** Lifetime of a successful authority check of one exact commit. */
  validationMs: number;
  /** Minimum time since the last successful refresh before a request fetches again. */
  refreshMs: number;
  /** Host-wide acquisitions and refreshes running at once. */
  operations: number;
  /** Distinct operations that may wait for admission. */
  waiters: number;
}
export const REFERENCE_SOURCE_DEFAULTS: ReferenceSourceLimits = Object.freeze({ validationMs: 300_000, refreshMs: 300_000, operations: 2, waiters: 64 });

export type ReferenceSourceErrorCode = "invalid" | "unauthorized" | "missing" | "unavailable" | "capacity" | "busy" | "cancelled";
export class ReferenceSourceError extends Error {
  constructor(readonly code: ReferenceSourceErrorCode, message: string) { super(message); this.name = "ReferenceSourceError"; }
}

export interface ReferenceSourceLease {
  domain: "public" | "private";
  /** Native view identity and the host directory a worker binds to read it. */
  view: string;
  viewPath: string;
  /** Entry inside the view that resolves to the current complete revision. */
  name: string;
  repository: string;
  revision: string;
  commit: string;
  /** Last successful refresh and last successful authority check of `commit`, epoch ms. */
  refreshedAt: number;
  validatedAt: number;
  /** True when the latest refresh failed and the previous authorized revision is returned. */
  stale: boolean;
  error: string | null;
  /** Ends this reader's protection against capacity eviction. Idempotent. */
  release(): void;
}

interface SourceRow {
  domain: string; repository: string; revision: string; url: string; name: string; root_id: string | null; commit_id: string | null; ref: string | null;
  grant_id: string | null; refreshed_at: number | null; validated_at: number | null; last_error: string | null; last_failed_at: number | null; last_used_at: number;
}
interface Operation { key: string; domain: string; principalId: string | null; grantId: string | null; controller: AbortController; joiners: number; promise: Promise<Outcome> }
type Outcome = { kind: "source"; row: SourceRow; stale: boolean; error: string | null } | { kind: "not-public"; reason: "denied" | "unavailable"; detail: string };

const PUBLIC = "public";
const privateDomain = (principalId: string) => `private:${principalId}`;
const sourceKey = (domain: string, repository: string, revision: string) => `${domain}\u0000${repository}\u0000${revision}`;

/** A stable, plain view entry for one repository and revision. */
export function referenceSourceName(repository: ReferenceRepository, revision: string): string {
  const slug = (text: string, size: number) => text.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, size).replace(/[.-]+$/, "");
  const location = repository.canonical.replace(/^[a-z]+:\/\/\/?/, "");
  const hash = createHash("sha256").update(`${repository.canonical}\u0000${revision}`).digest("hex").slice(0, 10);
  return `${slug(location, 72) || "repository"}@${slug(revision, 32) || "ref"}-${hash}`;
}

export function createReferenceSources(options: {
  db: Database; pool: ReferencePool; transport: ReferenceTransport; brain: string;
  /** Host environment holding named credential values; a value alone never authorizes. */
  credentials: Readonly<Record<string, string | undefined>>;
  limits?: Partial<ReferenceSourceLimits>;
  now?: () => number;
  log?: Logger;
  /** Worktree dependencies (#2430) that capacity eviction must keep. */
  dependents?: (rootId: string) => boolean;
}) {
  const limits = { ...REFERENCE_SOURCE_DEFAULTS, ...options.limits };
  for (const key of ["validationMs", "refreshMs", "operations", "waiters"] as const)
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new ReferenceSourceError("invalid", `reference source ${key} must be a positive integer`);
  const { db, pool, transport } = options;
  const now = options.now ?? Date.now;
  const operations = new Map<string, Operation>();
  const leases = new Map<string, number>();
  const withdrawn = new Set<string>();
  /** In-flight withdrawals; an acquisition of the same source waits for its withdrawal to finish. */
  const withdrawals = new Map<string, Promise<void>>();
  /** Anonymous refusals, cached for one validation lifetime so private requests skip the probe. */
  const notPublic = new Map<string, number>();
  const queue: { start: () => void; signal: AbortSignal }[] = [];
  let active = 0, closed = false, allowance: number | undefined;

  const row = (domain: string, repository: string, revision: string) =>
    db.query("SELECT * FROM reference_sources WHERE domain = ? AND repository = ? AND revision = ?").get(domain, repository, revision) as SourceRow | null;
  function viewFor(domain: string): { id: string; hostPath: string | null } {
    const found = db.query("SELECT view_id, host_path FROM reference_views WHERE domain = ?").get(domain) as { view_id: string; host_path: string | null } | null;
    if (found) return { id: found.view_id, hostPath: found.host_path };
    const id = randomUUID();
    db.query("INSERT INTO reference_views (domain, view_id) VALUES (?, ?)").run(domain, id);
    return { id, hostPath: null };
  }
  const usable = (source: SourceRow | null): source is SourceRow & { root_id: string; commit_id: string; refreshed_at: number; validated_at: number } =>
    Boolean(source?.root_id && source.commit_id && source.refreshed_at !== null && source.validated_at !== null);
  const validationLive = (source: SourceRow) => source.validated_at !== null && now() < source.validated_at + limits.validationMs;

  function lease(source: SourceRow, stale: boolean, error: string | null): ReferenceSourceLease {
    if (!usable(source)) throw new ReferenceSourceError("unavailable", "No usable authorized reference source exists.");
    const key = sourceKey(source.domain, source.repository, source.revision), view = viewFor(source.domain);
    leases.set(key, (leases.get(key) ?? 0) + 1);
    db.query("UPDATE reference_sources SET last_used_at = ? WHERE domain = ? AND repository = ? AND revision = ?").run(now(), source.domain, source.repository, source.revision);
    let released = false;
    return { domain: source.domain === PUBLIC ? "public" : "private", view: view.id, viewPath: view.hostPath!, name: source.name, repository: source.repository,
      revision: source.revision, commit: source.commit_id, refreshedAt: source.refreshed_at, validatedAt: source.validated_at, stale, error,
      release() {
        if (released) return; released = true;
        const left = (leases.get(key) ?? 1) - 1;
        if (left > 0) { leases.set(key, left); return; }
        leases.delete(key);
        void settle(source.domain, source.repository, source.revision).catch(error => warn("reference source release failed", error));
      } };
  }
  function warn(body: string, error: unknown) {
    options.log?.emit({ severityText: "WARN", body: `${body}: ${error instanceof Error ? error.message : String(error)}` });
  }

  /** Release superseded and withdrawn roots once no reader protects them; forget a withdrawn source once nothing acts on it. */
  async function settle(domain: string, repository: string, revision: string) {
    const key = sourceKey(domain, repository, revision);
    if (leases.get(key)) return;
    const roots = db.query("SELECT id FROM reference_roots WHERE domain = ? AND repository = ? AND revision = ? AND state = 'superseded'")
      .all(domain, repository, revision) as { id: string }[];
    for (const root of roots) await releaseRoot(root.id);
    if (withdrawn.has(key) && !operations.has(key) && !withdrawals.has(key)) {
      db.query("DELETE FROM reference_sources WHERE domain = ? AND repository = ? AND revision = ? AND root_id IS NULL").run(domain, repository, revision);
      withdrawn.delete(key);
    }
  }
  /** A reservation is released only through the pool, after its writers stopped; a failure keeps the record for recovery. */
  async function releaseRoot(id: string) {
    if (options.dependents?.(id)) return;
    await pool.poolRelease(id);
    db.query("DELETE FROM reference_roots WHERE id = ?").run(id);
  }

  async function admit(signal: AbortSignal): Promise<() => void> {
    const done = () => { active--; const next = queue.shift(); if (next) next.start(); };
    if (active < limits.operations) { active++; return done; }
    if (queue.length >= limits.waiters) throw new ReferenceSourceError("busy", "Reference acquisition queue is full; retry later.");
    return new Promise((resolve, reject) => {
      const entry = { signal, start: () => {
        signal.removeEventListener("abort", cancel);
        // A cancelled waiter never takes the slot; hand it to the next one.
        if (signal.aborted) { reject(new ReferenceSourceError("cancelled", "Reference acquisition was cancelled.")); queue.shift()?.start(); return; }
        active++; resolve(done);
      } };
      const cancel = () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); reject(new ReferenceSourceError("cancelled", "Reference acquisition was cancelled while waiting.")); };
      queue.push(entry);
      signal.addEventListener("abort", cancel, { once: true });
    });
  }

  /** Join or start the single operation for one source in one domain. */
  function join(key: string, input: { domain: string; principalId: string | null; grantId: string | null }, work: (signal: AbortSignal) => Promise<Outcome>, signal?: AbortSignal): Promise<Outcome> {
    if (signal?.aborted) return Promise.reject(new ReferenceSourceError("cancelled", "Reference acquisition request was cancelled."));
    let operation = operations.get(key);
    if (!operation) {
      const controller = new AbortController();
      const created: Operation = { key, ...input, controller, joiners: 0, promise: Promise.resolve(undefined as never) };
      created.promise = (async () => {
        const done = await admit(controller.signal);
        try { return await work(controller.signal); } finally { done(); }
      })().finally(() => { operations.delete(key); void settle(...splitKey(key)).catch(error => warn("reference source settle failed", error)); });
      // Every outcome is observed even when no requester remains to receive it.
      created.promise.catch(() => {});
      operations.set(key, created);
      operation = created;
    }
    const joined = operation;
    joined.joiners++;
    return new Promise<Outcome>((resolve, reject) => {
      let finished = false;
      const leave = () => { if (finished) return; finished = true; signal?.removeEventListener("abort", cancel); if (--joined.joiners === 0) joined.controller.abort(new ReferenceSourceError("cancelled", "Every requester left.")); };
      const cancel = () => { leave(); reject(new ReferenceSourceError("cancelled", "Reference acquisition request was cancelled.")); };
      signal?.addEventListener("abort", cancel, { once: true });
      joined.promise.then(value => { if (!finished) { finished = true; joined.joiners--; signal?.removeEventListener("abort", cancel); resolve(value); } },
        error => { if (!finished) { finished = true; joined.joiners--; signal?.removeEventListener("abort", cancel); reject(error); } });
    });
  }
  const splitKey = (key: string) => key.split("\u0000") as [string, string, string];

  function token(grant: ReferenceGrant | null): string | null {
    if (!grant?.credential) return null;
    const value = options.credentials[grant.credential];
    if (!value) throw new ReferenceSourceError("unavailable", `The granted host credential ${grant.credential} is not configured.`);
    return value;
  }
  /** Private work is authorized only while its principal still holds a live covering grant. */
  function authorize(domain: string, principalId: string | null, repository: ReferenceRepository): ReferenceGrant | null {
    if (domain === PUBLIC) return null;
    const grant = coveringReferenceGrant(db, { brain: options.brain, principalId: principalId!, repository, now: now() });
    if (!grant) throw new ReferenceSourceError("unauthorized", "No live reference grant covers this repository for this principal.");
    return grant;
  }

  async function operate(signal: AbortSignal, input: { domain: string; principalId: string | null; repository: ReferenceRepository; revision: string; grant: ReferenceGrant | null }): Promise<Outcome> {
    const { domain, repository, revision } = input;
    // Admission may have waited: authority is read again now, and its credential with it.
    // A withdrawal of this source finishes before it is acquired again.
    await withdrawals.get(sourceKey(domain, repository.canonical, revision));
    const grant = domain === PUBLIC ? null : authorize(domain, input.principalId, repository);
    input = { ...input, grant };
    const credential = token(grant);
    const existing = row(domain, repository.canonical, revision);
    const check = await transport.resolve({ repository, revision, token: credential, signal });
    signal.throwIfAborted();
    if (!check.ok) {
      const detail = check.detail;
      if (domain === PUBLIC && check.reason !== "missing") {
        if (check.reason === "denied") notPublic.set(`${repository.canonical}\u0000${revision}`, now() + limits.validationMs);
        // Public authority failed: a public copy is served only inside its still-valid window, and never after a denial.
        if (existing && check.reason === "denied") { await withdraw(domain, repository.canonical, revision); return { kind: "not-public", reason: "denied", detail }; }
        if (existing && usable(existing) && validationLive(existing)) return failed(existing, detail);
        return { kind: "not-public", reason: check.reason, detail };
      }
      if (existing && usable(existing) && validationLive(existing) && check.reason === "unavailable") return failed(existing, detail);
      if (existing && check.reason !== "unavailable") await withdraw(domain, repository.canonical, revision);
      throw new ReferenceSourceError(check.reason === "missing" ? "missing" : check.reason === "denied" ? "unauthorized" : "unavailable", `Reference check failed: ${detail}`);
    }
    if (usable(existing) && existing.commit_id === check.commit) {
      // The exact published commit is confirmed under current authority: that is also a successful refresh.
      const at = now();
      db.query("UPDATE reference_sources SET validated_at = ?, refreshed_at = ?, last_error = NULL, ref = ? WHERE domain = ? AND repository = ? AND revision = ?")
        .run(at, at, check.ref, domain, repository.canonical, revision);
      return { kind: "source", row: row(domain, repository.canonical, revision)!, stale: false, error: null };
    }
    try {
      await acquire(signal, { ...input, credential, ref: check.ref, previous: existing });
      return { kind: "source", row: row(domain, repository.canonical, revision)!, stale: false, error: null };
    } catch (error) {
      if (signal.aborted) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      // A denied fetch is lost authority, never an outage: no stale copy survives it.
      if (error instanceof ReferenceTransportError && error.reason === "denied") {
        await withdraw(domain, repository.canonical, revision);
        if (domain === PUBLIC) { notPublic.set(`${repository.canonical}\u0000${revision}`, now() + limits.validationMs); return { kind: "not-public", reason: "denied", detail }; }
        throw new ReferenceSourceError("unauthorized", detail);
      }
      // The previous revision stays usable only inside its own still-valid authority.
      if (existing && usable(existing) && validationLive(existing)) return failed(existing, detail);
      throw error instanceof ReferenceSourceError ? error : new ReferenceSourceError(error instanceof ReferenceTransportError && error.reason === "capacity" ? "capacity" : "unavailable", detail);
    }
  }
  /** Record a failed refresh without advancing its successful refresh time. */
  function failed(existing: SourceRow, detail: string): Outcome {
    db.query("UPDATE reference_sources SET last_error = ?, last_failed_at = ? WHERE domain = ? AND repository = ? AND revision = ?")
      .run(detail, now(), existing.domain, existing.repository, existing.revision);
    return { kind: "source", row: row(existing.domain, existing.repository, existing.revision)!, stale: true, error: detail };
  }

  /** Reserve a staging root, evicting by capacity LRU on refusal. `staging.id` always names the identity to release on failure. */
  async function create(staging: { id: string }, from: string | null, signal: AbortSignal, protect: string): Promise<NativePoolRecord> {
    allowance ??= (await pool.poolStatus(signal)).limits.operationBytes;
    for (;;) {
      signal.throwIfAborted();
      try { return await pool.poolCreate(staging.id, "source", from, allowance, signal); }
      catch (error) {
        if ((error as { code?: string }).code !== "capacity") throw error;
        // A refused identity created nothing; settle it and use a fresh one once eviction made room.
        await releaseRoot(staging.id).catch(cleanup => warn("refused reference reservation did not settle; startup recovery retries it", cleanup));
        if (!(await evictOne(protect))) throw new ReferenceSourceError("capacity", "Reference pool has no room and no unprotected source to evict.");
        staging.id = randomUUID();
        db.query("INSERT INTO reference_roots (id, domain, repository, revision, state, created_at) VALUES (?, ?, ?, ?, 'staging', ?)").run(staging.id, ...splitKey(protect), now());
      }
    }
  }
  /** Capacity-driven LRU eviction of one unleased, idle, unprotected source. Reclamation is observed by the next admission. */
  async function evictOne(protect: string): Promise<boolean> {
    const candidates = db.query("SELECT * FROM reference_sources ORDER BY last_used_at ASC").all() as SourceRow[];
    for (const candidate of candidates) {
      const key = sourceKey(candidate.domain, candidate.repository, candidate.revision);
      if (key === protect || leases.get(key) || operations.has(key)) continue;
      const roots = db.query("SELECT id FROM reference_roots WHERE domain = ? AND repository = ? AND revision = ?").all(candidate.domain, candidate.repository, candidate.revision) as { id: string }[];
      if (roots.some(root => options.dependents?.(root.id))) continue;
      await withdraw(candidate.domain, candidate.repository, candidate.revision);
      return true;
    }
    // Superseded roots of sources no reader or operation holds; protected ones stay.
    const superseded = (db.query("SELECT id, domain, repository, revision FROM reference_roots WHERE state = 'superseded'").all() as { id: string; domain: string; repository: string; revision: string }[])
      .filter(root => { const key = sourceKey(root.domain, root.repository, root.revision); return !leases.get(key) && !operations.has(key) && !options.dependents?.(root.id); });
    let freed = false;
    for (const root of superseded) { try { await releaseRoot(root.id); freed = true; } catch (error) { warn("reference eviction release failed", error); } }
    return freed;
  }
  /** Remove a source's name now; release its roots once no reader protects them. */
  function withdraw(domain: string, repository: string, revision: string): Promise<void> {
    const key = sourceKey(domain, repository, revision);
    const running = withdrawals.get(key);
    if (running) return running;
    const source = row(domain, repository, revision);
    if (!source) return Promise.resolve();
    // Fence in this turn, before any await: no new reader may lease the source,
    // and only the roots it holds now are withdrawn, never a later acquisition's.
    withdrawn.add(key);
    db.query("UPDATE reference_sources SET root_id = NULL WHERE domain = ? AND repository = ? AND revision = ?").run(domain, repository, revision);
    const roots = db.query("SELECT id FROM reference_roots WHERE domain = ? AND repository = ? AND revision = ? AND state != 'staging'").all(domain, repository, revision) as { id: string }[];
    db.query("UPDATE reference_roots SET state = 'superseded' WHERE domain = ? AND repository = ? AND revision = ? AND state = 'published'").run(domain, repository, revision);
    const view = viewFor(domain);
    const work = (async () => {
      await pool.poolUnpublish(view.id, source.name);
      // Every root leaves the view at once, so no reader reaches it by identity; storage waits for readers.
      for (const root of roots) await pool.poolWithdraw(root.id);
    })().finally(() => { withdrawals.delete(key); });
    withdrawals.set(key, work);
    return work.then(() => settle(domain, repository, revision));
  }

  async function acquire(signal: AbortSignal, input: { domain: string; principalId: string | null; repository: ReferenceRepository; revision: string; grant: ReferenceGrant | null;
    credential: string | null; ref: string; previous: SourceRow | null }) {
    const { domain, repository, revision } = input, key = sourceKey(domain, repository.canonical, revision);
    const name = referenceSourceName(repository, revision), view = viewFor(domain);
    const staging = { id: randomUUID() };
    db.query("INSERT INTO reference_roots (id, domain, repository, revision, state, created_at) VALUES (?, ?, ?, ?, 'staging', ?)").run(staging.id, domain, repository.canonical, revision, now());
    const previousRoot = input.previous?.root_id ?? null;
    const recheck = () => { if (domain !== PUBLIC && (!input.grant || !isLiveReferenceGrant(db, input.grant.id, now()))) authorize(domain, input.principalId, repository); };
    let publishing = false;
    try {
      const record = await create(staging, previousRoot, signal, key);
      recheck();
      const { commit } = await transport.fetch({ repository, ref: input.ref, token: input.credential, root: record.path!, signal });
      await transport.checkout({ root: record.path!, commit, signal });
      signal.throwIfAborted();
      recheck();
      await pool.poolSeal(staging.id, signal);
      // Authority is read again immediately before the only step readers can observe.
      recheck();
      signal.throwIfAborted();
      publishing = true;
      const published = await pool.poolPublish(staging.id, view.id, name, signal);
      const at = now(), grantId = domain === PUBLIC ? null : (input.grant && isLiveReferenceGrant(db, input.grant.id, at) ? input.grant.id : authorize(domain, input.principalId, repository)!.id);
      db.transaction(() => {
        db.query("UPDATE reference_views SET host_path = ? WHERE domain = ?").run(dirname(published.path!), domain);
        db.query("UPDATE reference_roots SET state = 'superseded' WHERE domain = ? AND repository = ? AND revision = ? AND state = 'published'").run(domain, repository.canonical, revision);
        db.query("UPDATE reference_roots SET state = 'published' WHERE id = ?").run(staging.id);
        db.query(`INSERT INTO reference_sources (domain, repository, revision, url, name, root_id, commit_id, ref, grant_id, refreshed_at, validated_at, last_error, last_failed_at, last_used_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
          ON CONFLICT (domain, repository, revision) DO UPDATE SET url = excluded.url, name = excluded.name, root_id = excluded.root_id, commit_id = excluded.commit_id,
            ref = excluded.ref, grant_id = excluded.grant_id, refreshed_at = excluded.refreshed_at, validated_at = excluded.validated_at, last_error = NULL`)
          .run(domain, repository.canonical, revision, repository.url, name, staging.id, commit, input.ref, grantId, at, at, at);
      }).immediate();
      withdrawn.delete(key);
    } catch (error) {
      // Staging is never published; its reservation is released through the pool only now that the workers stopped.
      const id = staging.id;
      const state = (db.query("SELECT state FROM reference_roots WHERE id = ?").get(id) as { state: string } | null)?.state;
      if (state === "staging") await releaseRoot(id).catch(cleanup => warn("reference staging release failed; startup recovery retries it", cleanup));
      // A publication whose reply was lost may have moved the name to the released root: point it back, or fence the source.
      if (publishing && previousRoot) await pool.poolPublish(previousRoot, view.id, name).catch(async () => {
        await withdraw(domain, repository.canonical, revision).catch(cleanup => warn("reference source could not be fenced after a lost publication", cleanup));
      });
      throw error;
    }
  }

  async function request(input: { principalId: string; repository: unknown; revision: unknown; signal?: AbortSignal }): Promise<ReferenceSourceLease> {
    if (closed) throw new ReferenceSourceError("unavailable", "Reference sources are closed.");
    if (input.signal?.aborted) throw new ReferenceSourceError("cancelled", "Reference acquisition request was cancelled.");
    let repository: ReferenceRepository, revision: string;
    try { repository = referenceRepository(input.repository); revision = referenceRevision(input.revision); }
    catch (error) { throw new ReferenceSourceError("invalid", (error as Error).message); }
    const probeKey = `${repository.canonical}\u0000${revision}`;
    const fresh = (source: SourceRow | null) => usable(source) && validationLive(source) && now() < source.refreshed_at + limits.refreshMs;
    if (repository.scheme !== "file" && !((notPublic.get(probeKey) ?? 0) > now())) {
      const current = row(PUBLIC, repository.canonical, revision);
      if (fresh(current) && !withdrawn.has(sourceKey(PUBLIC, repository.canonical, revision))) return lease(current!, false, null);
      const outcome = await join(sourceKey(PUBLIC, repository.canonical, revision), { domain: PUBLIC, principalId: null, grantId: null },
        signal => operate(signal, { domain: PUBLIC, principalId: null, repository, revision, grant: null }), input.signal);
      if (outcome.kind === "source") return lease(outcome.row, outcome.stale, outcome.error);
      // An unanswered public check proves nothing; only a covering grant may try the private path.
      if (outcome.reason === "unavailable" && !coveringReferenceGrant(db, { brain: options.brain, principalId: input.principalId, repository, now: now() }))
        throw new ReferenceSourceError("unavailable", `Reference check failed: ${outcome.detail}`);
    }
    const domain = privateDomain(input.principalId);
    const grant = authorize(domain, input.principalId, repository);
    const current = row(domain, repository.canonical, revision);
    if (fresh(current) && !withdrawn.has(sourceKey(domain, repository.canonical, revision))) return lease(current!, false, null);
    const outcome = await join(sourceKey(domain, repository.canonical, revision), { domain, principalId: input.principalId, grantId: grant!.id },
      signal => operate(signal, { domain, principalId: input.principalId, repository, revision, grant }), input.signal);
    if (outcome.kind !== "source") throw new ReferenceSourceError("unavailable", outcome.detail);
    // Authority may have ended while the operation ran: a private lease is granted only under a live grant.
    authorize(domain, input.principalId, repository);
    return lease(outcome.row, outcome.stale, outcome.error);
  }

  /**
   * Lost authority: cancel in-flight private work and withdraw private sources
   * no live grant covers any more. Readers keep bytes they already read.
   */
  async function revoke(input: { grantIds: readonly string[]; principalIds: readonly string[] }) {
    const principals = new Set(input.principalIds);
    for (const id of input.grantIds) {
      const owner = db.query("SELECT principal_id FROM reference_grants WHERE id = ?").get(id) as { principal_id: string } | null;
      if (owner) principals.add(owner.principal_id);
    }
    for (const operation of operations.values())
      if (operation.domain !== PUBLIC && (principals.has(operation.principalId!) || input.grantIds.includes(operation.grantId!)))
        operation.controller.abort(new ReferenceSourceError("unauthorized", "Reference authority was revoked."));
    for (const principalId of principals) {
      const sources = db.query("SELECT * FROM reference_sources WHERE domain = ?").all(privateDomain(principalId)) as SourceRow[];
      for (const source of sources) {
        let covered = false;
        try { covered = Boolean(coveringReferenceGrant(db, { brain: options.brain, principalId, repository: referenceRepository(source.repository), now: now() })); } catch { covered = false; }
        if (!covered) await withdraw(source.domain, source.repository, source.revision);
      }
    }
  }

  /** Reconcile the disposable catalog with owned pool roots after a restart. */
  async function recover(): Promise<{ released: string[]; retained: string[] }> {
    const released: string[] = [], retained: string[] = [];
    const records: NativePoolRecord[] = [];
    for (let after: string | null = null; ;) {
      const page = await pool.listPoolRecovery(after);
      records.push(...page.records);
      if (!page.next) break;
      after = page.next;
    }
    const byId = new Map(records.map(record => [record.id, record]));
    // A recorded source survives only with its sealed root, its name re-asserted
    // (repairing a publication whose reply was lost) and, if private, a live grant.
    const keep = new Set<string>();
    for (const source of db.query("SELECT * FROM reference_sources WHERE root_id IS NOT NULL").all() as SourceRow[]) {
      const record = byId.get(source.root_id!);
      let usableRoot = record?.purpose === "source" && record.state === "sealed";
      if (usableRoot && source.domain !== PUBLIC) {
        try { usableRoot = Boolean(coveringReferenceGrant(db, { brain: options.brain, principalId: source.domain.slice("private:".length), repository: referenceRepository(source.repository), now: now() })); }
        catch { usableRoot = false; }
      }
      if (usableRoot) {
        try { await pool.poolPublish(source.root_id!, viewFor(source.domain).id, source.name); keep.add(source.root_id!); continue; }
        catch (error) { warn("reference source publication could not be restored", error); }
      }
      db.query("UPDATE reference_sources SET root_id = NULL WHERE domain = ? AND repository = ? AND revision = ?").run(source.domain, source.repository, source.revision);
    }
    // Everything else this app owns goes: interrupted staging, superseded or
    // withdrawn roots, roots the catalog lost and interrupted deletions.
    for (const record of records) {
      if (record.purpose !== "source" || record.state === "reclaimed" || keep.has(record.id)) continue;
      try { await pool.poolRelease(record.id); released.push(record.id); }
      catch { retained.push(record.id); }
    }
    for (const { id } of db.query("SELECT id FROM reference_roots").all() as { id: string }[])
      if (!keep.has(id) && !retained.includes(id)) db.query("DELETE FROM reference_roots WHERE id = ?").run(id);
    db.query("UPDATE reference_roots SET state = 'published' WHERE id IN (SELECT root_id FROM reference_sources WHERE root_id IS NOT NULL)").run();
    db.query("DELETE FROM reference_sources WHERE root_id IS NULL").run();
    return { released, retained };
  }

  return {
    request,
    revoke,
    recover,
    /** Host directories a worker of this principal binds; null until something was published there. */
    views(principalId: string): { public: string | null; private: string | null } {
      const path = (domain: string) => (db.query("SELECT host_path FROM reference_views WHERE domain = ?").get(domain) as { host_path: string | null } | null)?.host_path ?? null;
      return { public: path(PUBLIC), private: path(privateDomain(principalId)) };
    },
    /** Operations admitted or waiting, for status reporting; private keys are not disclosed. */
    activity(): { active: number; waiting: number } { return { active, waiting: queue.length }; },
    async close() {
      closed = true;
      for (const operation of operations.values()) operation.controller.abort(new ReferenceSourceError("cancelled", "Server shutting down."));
      for (const entry of queue.splice(0)) entry.start();
      await Promise.allSettled([...operations.values()].map(operation => operation.promise));
    },
  };
}
export type ReferenceSources = ReturnType<typeof createReferenceSources>;
