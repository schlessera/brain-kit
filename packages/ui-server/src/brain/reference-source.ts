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
import { referenceWrites } from "./reference-writes.js";
import { sourceWrites } from "./reference-source-writes.js";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { createNativeBrainManagerClient, NativePoolRecord } from "@schlessera/brain-ui-sdk/internal";
import type { Logger } from "@opentelemetry/api-logs";
import { coveringReferenceGrant, isLiveReferenceGrant, referenceRepository, referenceRepositoryFromKey, type ReferenceGrant, type ReferenceRepository } from "../db/reference-grants.js";
import { referenceRevision, ReferenceTransportError, type ReferenceTransport } from "./reference-transport.js";
import { GitHubReferenceMetadataError, type createGitHubReferenceAccess } from "./github-reference-access.js";
import { githubReferenceRepository } from "./github-reference-identity.js";
import { referenceAcquisitionMatches, type ReferenceAcquisition, type ReferenceAcquisitionContext } from "./reference-acquisition.js";
import { authorityRepository, sourceAuthority, sourceAuthorityCurrent, type SourceAuthority } from "./reference-source-authority.js";

type GitHubAccess = Awaited<ReturnType<ReturnType<typeof createGitHubReferenceAccess>["open"]>>;

type Client = ReturnType<typeof createNativeBrainManagerClient>;
export type ReferencePool = Pick<Client, "poolStatus" | "poolCreate" | "poolSeal" | "poolRelease" | "poolPublish" | "poolView" | "poolUnpublish" | "poolWithdraw" | "listPoolRecovery">;

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
  /** Actual fetched endpoint, retained independently of the canonical authority key. Host-only. */
  repositoryUrl: string;
  revision: string;
  commit: string;
  /** Sealed pool root holding `commit`; a managed worktree (#2430) snapshots it. */
  rootId: string;
  /** Last successful refresh and last successful authority check of `commit`, epoch ms. */
  refreshedAt: number;
  validatedAt: number;
  /** True when the latest refresh failed and the previous authorized revision is returned. */
  stale: boolean;
  error: string | null;
  /** Host-only lifetime check for effects awaiting after this acquisition; never a source trust capability. */
  assertAuthority(): void;
  /** Ends this reader's protection against capacity eviction. Idempotent. */
  release(): void;
}

interface SourceRow {
  domain: string; repository: string; revision: string; url: string; name: string; root_id: string | null; commit_id: string | null; ref: string | null;
  grant_id: string | null; refreshed_at: number | null; validated_at: number | null; last_error: string | null; last_failed_at: number | null; last_used_at: number;
}
interface Operation { key: string; domain: string; principalId: string | null; grantId: string | null; controller: AbortController; joiners: number; promise: Promise<Outcome> }
interface InvalidatedRoot { id: string; state: string; repository: string; revision: string }
interface WithheldSource { rootId: string | null; validatedAt: number | null }
type Outcome = { kind: "source"; row: SourceRow; stale: boolean; error: string | null } | { kind: "not-public"; reason: "denied" | "unavailable"; detail: string };
/** Only host callers reading the catalog use repositoryKey; tool inputs remain raw strings. */
type RepositoryInput = { repository: unknown; repositoryKey?: never; repositoryUrl?: never }
  | { repository?: never; repositoryKey: string; repositoryUrl?: string };

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
  /** Production GitHub requests require the actual turn's bounded host wire. */
  github?: ReturnType<typeof createGitHubReferenceAccess>;
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
  const write = referenceWrites(db);
  const now = options.now ?? Date.now;
  const operations = new Map<string, Operation>();
  const operating = (key: string) => [...operations.values()].some(operation => operation.key === key);
  const isManaged = (repository: string) => Boolean(options.github && new URL(repository).hostname.toLowerCase() === "github.com");
  /** Use the fixed transport's GitHub identity for cache keys and grant checks alike. */
  function repositoryLocation(input: unknown): ReferenceRepository {
    const repository = referenceRepository(input);
    return isManaged(repository.canonical) ? referenceRepository(githubReferenceRepository(repository.url).cloneUrl) : repository;
  }
  const leases = new Map<string, number>();
  const withdrawn = new Map<string, WithheldSource>();
  /** A newer authority observation invalidates older managed requests, including before domain selection. */
  const authorityFences = new Map<string, number>();
  /** In-flight withdrawals; an acquisition of the same source waits for its withdrawal to finish. */
  const withdrawals = new Map<string, Promise<void>>();
  /**
   * Sources out of their view because a bind found their validation lapsed and
   * it was not renewed (#2432). Their roots stay charged and cached; the next
   * request that validates them publishes them again. `unsettled` holds those
   * whose suspension did not finish: a bind retries it and refuses until it
   * does. Suspension also expires durable validation, so a new service's
   * bind preparation withholds uncertain authority before exposing its view.
   */
  const suspended = new Map<string, WithheldSource>(), unsettled = new Set<string>();
  /** Confirmed absence from views; only permanent native withdrawal survives another bind. */
  const hiddenRoots = new Map<string, boolean>();
  /** Native publication may have taken effect before its catalog receipt exists. */
  const pendingPublications = new Map<string, { key: string; view: string; name: string }>();
  /** Bind-time revalidations in flight, joined by concurrent binds. */
  const revalidations = new Map<string, Promise<boolean>>();
  /** Lapsed sources a bind checks at once. */
  const BIND_CHECKS = 4;
  /**
   * Validation a source needs left at a bind, so it does not lapse between
   * admission and its workers' mounts: a minute, or half a shorter lifetime. A
   * fresh check always leaves more than this.
   */
  const BIND_MARGIN = () => Math.min(60_000, Math.floor(limits.validationMs / 2));
  const validFor = (source: SourceRow) => source.validated_at === null ? -Infinity : source.validated_at + limits.validationMs - now();
  /**
   * Wait for shared work without cancelling it: a cancelled bind stops waiting
   * and the work goes on. `settle` waits for the outcome either way; otherwise
   * the work's failure is the caller's.
   */
  function abortable<T>(work: Promise<T> | undefined, signal?: AbortSignal, settle = true): Promise<T | undefined> {
    signal?.throwIfAborted();
    if (!work) return Promise.resolve(undefined);
    const watched: Promise<T | undefined> = settle ? work.catch(() => undefined) : work;
    if (!signal) return watched;
    return new Promise((resolve, reject) => {
      const stop = () => reject(signal.reason ?? new ReferenceSourceError("cancelled", "The bind was cancelled."));
      signal.addEventListener("abort", stop, { once: true });
      void watched.then(value => { signal.removeEventListener("abort", stop); resolve(value); },
        error => { signal.removeEventListener("abort", stop); reject(error); });
    });
  }
  /**
   * Take one root out of its view. A root the pool already released has no
   * name left, and the pool refuses to withdraw it: its release, whose reply
   * may have been lost, is settled instead.
   */
  async function hideRoot(id: string) {
    let permanent = false;
    try { permanent = (await pool.poolWithdraw(id)).publicationRevoked === true; }
    catch (error) {
      if ((error as { code?: string }).code !== "released") throw error;
      await releaseRoot(id);
      permanent = true;
    }
    hiddenRoots.set(id, permanent);
    pendingPublications.delete(id);
  }
  /** Another owner can have native publication but only a staging catalog row. */
  async function hideRecordedRoot(root: { id: string; state: string }) {
    if (root.state !== "staging") return hideRoot(root.id);
    let permanent = false;
    try {
      const record = await pool.poolWithdraw(root.id);
      permanent = record.publicationRevoked === true;
      // A sealed staging root has no active writer. Retire its identity so a
      // delayed publication RPC cannot expose it after this owner returns.
      if (record.state !== "writable" && record.state !== "reserved") { const released = await releaseRoot(root.id); permanent ||= released; }
    } catch (error) {
      if (!["unknown", "released"].includes((error as { code?: string }).code ?? "")) throw error;
      // Release also fences a create that has not arrived at the manager yet.
      const released = await releaseRoot(root.id);
      permanent = released || (error as { code?: string }).code === "released";
    }
    hiddenRoots.set(root.id, permanent);
    pendingPublications.delete(root.id);
  }
  async function nativeRoot(id: string): Promise<NativePoolRecord | undefined> {
    for (let after: string | null = null; ;) {
      const page = await pool.listPoolRecovery(after);
      const record = page.records.find(record => record.id === id);
      if (record || !page.next) return record;
      after = page.next;
    }
  }
  /** One change at a time to a source's exposure: suspension, restoration, withdrawal and publication. */
  const exposing = new Map<string, Promise<unknown>>();
  function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (exposing.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    const settled = next.catch(() => {});
    exposing.set(key, settled);
    void settled.then(() => { if (exposing.get(key) === settled) exposing.delete(key); });
    return next;
  }
  /** Anonymous refusals, cached for one validation lifetime so private requests skip the probe. */
  const notPublic = new Map<string, number>();
  const queue: { start: () => void; signal: AbortSignal }[] = [];
  let active = 0, closed = false, allowance: number | undefined;

  const row = (domain: string, repository: string, revision: string) =>
    db.query("SELECT * FROM reference_sources WHERE domain = ? AND repository = ? AND revision = ?").get(domain, repository, revision) as SourceRow | null;
  async function viewFor(domain: string): Promise<{ id: string; hostPath: string | null }> {
    const found = db.query("SELECT view_id, host_path FROM reference_views WHERE domain = ?").get(domain) as { view_id: string; host_path: string | null } | null;
    if (found) return { id: found.view_id, hostPath: found.host_path };
    return write("sourceView", domain, randomUUID());
  }
  const usable = (source: SourceRow | null): source is SourceRow & { root_id: string; commit_id: string; refreshed_at: number; validated_at: number } =>
    Boolean(source?.root_id && source.commit_id && source.refreshed_at !== null && source.validated_at !== null);
  const validationLive = (source: SourceRow) => source.validated_at !== null && now() < source.validated_at + limits.validationMs;
  const sourceStamp = (source: SourceRow | null): WithheldSource => ({ rootId: source?.root_id ?? null, validatedAt: source?.validated_at ?? null });
  /** A key can name a different publication, or the same root validated anew by another owner. */
  function withholding(source: SourceRow | null): "live" | "hidden" | "unknown" {
    if (!source?.root_id) return "live";
    const key = sourceKey(source.domain, source.repository, source.revision);
    const matches = [suspended.get(key), withdrawn.get(key)].some(stamp => stamp?.rootId === source.root_id && stamp.validatedAt === source.validated_at);
    return !matches ? "live" : hiddenRoots.has(source.root_id) ? "hidden" : "unknown";
  }

  async function lease(source: SourceRow, stale: boolean, error: string | null, authority?: () => void): Promise<ReferenceSourceLease> {
    if (!usable(source)) throw new ReferenceSourceError("unavailable", "No usable authorized reference source exists.");
    const key = sourceKey(source.domain, source.repository, source.revision);
    const fence = authorityFences.get(key) ?? 0;
    const durable = sourceAuthority(db, source.domain, source.repository, source.revision);
    const assertAuthority = () => {
      if (closed) throw new ReferenceSourceError("unavailable", "Reference sources are closed.");
      if (fence !== (authorityFences.get(key) ?? 0) || withdrawn.has(key))
        throw new ReferenceSourceError(suspended.has(key) ? "unavailable" : "unauthorized", "A newer observation invalidated this source's authority.");
      // App/cron owners share the catalog, not these process-local fences.
      // New effects must still name this publication after their own waits.
      const current = row(source.domain, source.repository, source.revision);
      if (!usable(current) || current.root_id !== source.root_id || current.commit_id !== source.commit_id || current.ref !== source.ref)
        throw new ReferenceSourceError("unauthorized", "This source publication is no longer authoritative.");
      if (suspended.has(key) || !validationLive(source) || !validationLive(current))
        throw new ReferenceSourceError("unavailable", "This source's authority needs fresh validation.");
      if (!sourceAuthorityCurrent(db, durable))
        throw new ReferenceSourceError("unauthorized", "A newer durable observation invalidated this source's authority.");
      authority?.();
    };
    leases.set(key, (leases.get(key) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return; released = true;
      const left = (leases.get(key) ?? 1) - 1;
      if (left > 0) { leases.set(key, left); return; }
      leases.delete(key);
      void settle(source.domain, source.repository, source.revision).catch(error => warn("reference source release failed", error));
    };
    try {
      const view = await viewFor(source.domain);
      await write("sourceTouch", now(), source.domain, source.repository, source.revision);
      return { domain: source.domain === PUBLIC ? "public" : "private", view: view.id, viewPath: view.hostPath!, name: source.name, repository: source.repository, repositoryUrl: source.url,
        revision: source.revision, commit: source.commit_id, rootId: source.root_id, refreshedAt: source.refreshed_at, validatedAt: source.validated_at, stale, error,
        assertAuthority, release };
    } catch (error) { release(); throw error; }
  }

  function warn(body: string, error: unknown) {
    options.log?.emit({ severityText: "WARN", body: `${body}: ${error instanceof Error ? error.message : String(error)}` });
  }
  function failureReason(error: unknown): string | null {
    return error instanceof ReferenceTransportError ? error.reason : error instanceof ReferenceSourceError ? error.code : null;
  }

  /** Release superseded and withdrawn roots once no reader protects them; forget a withdrawn source once nothing acts on it. */
  async function settle(domain: string, repository: string, revision: string) {
    const key = sourceKey(domain, repository, revision);
    if (leases.get(key)) return;
    const roots = db.query("SELECT id FROM reference_roots WHERE domain = ? AND repository = ? AND revision = ? AND state = 'superseded'")
      .all(domain, repository, revision) as { id: string }[];
    for (const root of roots) await releaseRoot(root.id);
    if (withdrawn.has(key) && !operating(key) && !withdrawals.has(key)) {
      // A failed withdrawal still needs retrying; a replacement keeps its own
      // lifetime. Neither is forgotten just because older readers finished.
      if (row(domain, repository, revision)?.root_id) return;
      const stamp = withdrawn.get(key);
      await write("sourceForget", domain, repository, revision);
      if (withdrawn.get(key) === stamp) withdrawn.delete(key);
    }
  }
  /** A reservation is released only through the pool, after its writers stopped; a failure keeps the record for recovery. */
  async function releaseRoot(id: string) {
    if (options.dependents?.(id)) return false;
    await pool.poolRelease(id);
    await write("sourceReleaseRoot", id);
    pendingPublications.delete(id);
    return true;
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
    const grant = coveringReferenceGrant(db, { brain: options.brain, principalId: principalId!, repository: repositoryLocation(repository.url), now: now() });
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
    const check = await transport.resolve({ repository, revision, token: credential, signal }).catch((error: unknown) => {
      if (error instanceof ReferenceTransportError && (error.reason === "invalid" || error.reason === "busy")) throw new ReferenceSourceError(error.reason, error.message);
      throw error;
    });
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
      await write("sourceValidate", at, at, check.ref, domain, repository.canonical, revision);
      return { kind: "source", row: row(domain, repository.canonical, revision)!, stale: false, error: null };
    }
    try {
      await acquire(signal, { ...input, credential, ref: check.ref, expectedCommit: check.commit, previous: existing });
      return { kind: "source", row: row(domain, repository.canonical, revision)!, stale: false, error: null };
    } catch (error) {
      if (signal.aborted) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      // A denied fetch is lost authority, never an outage: no stale copy survives it.
      if (failureReason(error) === "denied" || failureReason(error) === "unauthorized") {
        await withdraw(domain, repository.canonical, revision);
        if (domain === PUBLIC) { notPublic.set(`${repository.canonical}\u0000${revision}`, now() + limits.validationMs); return { kind: "not-public", reason: "denied", detail }; }
        throw new ReferenceSourceError("unauthorized", detail);
      }
      // The previous revision stays usable only inside its own still-valid authority.
      if (existing && usable(existing) && validationLive(existing)) return failed(existing, detail);
      throw error instanceof ReferenceSourceError ? error
        : new ReferenceSourceError(error instanceof ReferenceTransportError && (error.reason === "capacity" || error.reason === "busy") ? error.reason : "unavailable", detail);
    }
  }
  /** Record a failed refresh without advancing its successful refresh time. */
  async function failed(existing: SourceRow, detail: string): Promise<Outcome> {
    await write("sourceFailed", detail, now(), existing.domain, existing.repository, existing.revision);
    return { kind: "source", row: row(existing.domain, existing.repository, existing.revision)!, stale: true, error: detail };
  }

  /** Reserve a staging root, evicting by capacity LRU on refusal. `staging.id` always names the identity to release on failure. */
  async function create(staging: { id: string }, from: string | null, signal: AbortSignal, protect: string): Promise<NativePoolRecord> {
    allowance ??= (await pool.poolStatus(signal)).limits.operationBytes;
    for (;;) {
      signal.throwIfAborted();
      try { return await pool.poolCreate(staging.id, "source", from, allowance, signal, isManaged(splitKey(protect)[1]) ? true : undefined); }
      catch (error) {
        if ((error as { code?: string }).code !== "capacity") throw error;
        // A refused identity created nothing; settle it and use a fresh one once eviction made room.
        await releaseRoot(staging.id).catch(cleanup => warn("refused reference reservation did not settle; startup recovery retries it", cleanup));
        if (!(await evictOne(protect))) throw new ReferenceSourceError("capacity", "Reference pool has no room and no unprotected source to evict.");
        staging.id = randomUUID();
        await write("sourceStage", staging.id, ...splitKey(protect), now());
      }
    }
  }
  /** Capacity-driven LRU eviction of one unleased, idle, unprotected source. Reclamation is observed by the next admission. */
  async function evictOne(protect: string): Promise<boolean> {
    const candidates = db.query("SELECT * FROM reference_sources ORDER BY last_used_at ASC").all() as SourceRow[];
    for (const candidate of candidates) {
      const key = sourceKey(candidate.domain, candidate.repository, candidate.revision);
      if (key === protect || leases.get(key) || operating(key)) continue;
      const roots = db.query("SELECT id FROM reference_roots WHERE domain = ? AND repository = ? AND revision = ?").all(candidate.domain, candidate.repository, candidate.revision) as { id: string }[];
      if (roots.some(root => options.dependents?.(root.id))) continue;
      await withdraw(candidate.domain, candidate.repository, candidate.revision);
      return true;
    }
    // Superseded roots of sources no reader or operation holds; protected ones stay.
    const superseded = (db.query("SELECT id, domain, repository, revision FROM reference_roots WHERE state = 'superseded'").all() as { id: string; domain: string; repository: string; revision: string }[])
      .filter(root => { const key = sourceKey(root.domain, root.repository, root.revision); return !leases.get(key) && !operating(key) && !options.dependents?.(root.id); });
    let freed = false;
    for (const root of superseded) { try { await releaseRoot(root.id); freed = true; } catch (error) { warn("reference eviction release failed", error); } }
    return freed;
  }
  /** Remove a source's name now; release its roots once no reader protects them. */
  function withdraw(domain: string, repository: string, revision: string, captured?: InvalidatedRoot[]): Promise<void> {
    const key = sourceKey(domain, repository, revision);
    const stamp = sourceStamp(row(domain, repository, revision));
    const fenced = captured ? Promise.resolve(captured) : fenceSource(key);
    // Fence before any await, even when the first publication has no catalog
    // row yet. A later acquisition waits for this withdrawal to finish.
    withdrawn.set(key, stamp);
    suspended.delete(key); unsettled.delete(key);
    // Observe the catalog after every already-dispatched publication settles,
    // including one whose native reply or database receipt was still pending.
    const work = exclusive(key, async () => {
      const invalidated = await fenced;
      stamp.validatedAt = 0;
      if (isManaged(repository)) {
        for (const root of invalidated) {
          const recorded = await write<{ id: string; state: string } | null>("sourceDiscard", root.id);
          await hideRecordedRoot(recorded ?? root);
        }
        const current = row(domain, repository, revision);
        if (current?.root_id && !invalidated.some(root => root.id === current.root_id) && withdrawn.get(key) === stamp) withdrawn.delete(key);
        return;
      }
      const source = row(domain, repository, revision);
      const { roots, view } = await write<{ roots: { id: string; state: string }[]; view: { id: string } }>("sourceWithdraw", domain, repository, revision, randomUUID());
      if (source) await pool.poolUnpublish(view.id, source.name);
      // Include another owner's staging row, even before a source catalog exists.
      for (const root of roots) await hideRecordedRoot(root);
      // A first publication can have native exposure but still be staging in
      // SQLite. Hide it here too, without waiting for storage reclamation.
      for (const [id, publication] of pendingPublications) if (publication.key === key) {
        await pool.poolUnpublish(publication.view, publication.name);
        await hideRoot(id);
      }
    }).finally(() => { if (withdrawals.get(key) === work) withdrawals.delete(key); });
    withdrawals.set(key, work);
    return work.then(() => settle(domain, repository, revision));
  }
  function fenceSource(key: string): Promise<InvalidatedRoot[]> {
    authorityFences.set(key, (authorityFences.get(key) ?? 0) + 1);
    const [domain, repository, revision] = splitKey(key);
    return write("sourceFence", domain, authorityRepository(repository), revision, randomUUID());
  }
  /** Repository metadata governs every cached or in-flight revision, not only the requested one. */
  function repositoryKeys(domain: string, repository: string, revision: string): string[] {
    const keys = new Set([sourceKey(domain, repository, revision)]);
    const equivalent = (candidate: string) => {
      if (candidate === repository) return true;
      try { return authorityRepository(candidate) === repository; } catch { return false; }
    };
    for (const row of db.query(`SELECT repository, revision FROM reference_sources WHERE domain = ?
      UNION SELECT repository, revision FROM reference_roots WHERE domain = ?`).all(domain, domain) as { repository: string; revision: string }[])
      if (equivalent(row.repository)) keys.add(sourceKey(domain, row.repository, row.revision));
    for (const operation of operations.values()) {
      const [heldDomain, heldRepository, heldRevision] = splitKey(operation.key);
      if (equivalent(heldRepository) && (heldDomain === domain || (operation.principalId !== null && domain === privateDomain(operation.principalId)))) keys.add(sourceKey(domain, heldRepository, heldRevision));
    }
    return [...keys];
  }
  async function withdrawRepository(domain: string, repository: string, revision: string): Promise<void[]> {
    const captured = await fenceSource(sourceKey(domain, repository, ""));
    return Promise.all(repositoryKeys(domain, repository, revision).map(key => {
      const parts = splitKey(key);
      return withdraw(...parts, captured.filter(root => root.repository === parts[1] && root.revision === parts[2]));
    }));
  }
  async function suspendRepository(domain: string, repository: string, revision: string): Promise<void[]> {
    const captured = await fenceSource(sourceKey(domain, repository, ""));
    return Promise.all(repositoryKeys(domain, repository, revision).map(key => {
      const parts = splitKey(key);
      return suspendSource(...parts, false, captured.filter(root => root.repository === parts[1] && root.revision === parts[2]));
    }));
  }

  async function acquire(signal: AbortSignal, input: { domain: string; principalId: string | null; repository: ReferenceRepository; revision: string; grant: ReferenceGrant | null;
    credential: string | null; ref: string; expectedCommit: string; previous: SourceRow | null;
    managed?: { access: GitHubAccess; context: ReferenceAcquisitionContext; id: string; authority: SourceAuthority; assertCurrent(): void; containFailure(error: unknown, publishing: boolean, publicationId?: string): Promise<void> } }) {
    const { domain, repository, revision } = input, key = sourceKey(domain, repository.canonical, revision);
    const name = referenceSourceName(repository, revision), view = await viewFor(domain);
    const staging = { id: randomUUID() };
    await write("sourceStage", staging.id, domain, repository.canonical, revision, now());
    const previousRoot = input.previous?.root_id ?? null;
    const recheck = () => {
      signal.throwIfAborted();
      input.managed?.assertCurrent();
      if (domain !== PUBLIC && (!input.grant || !isLiveReferenceGrant(db, input.grant.id, now()))) authorize(domain, input.principalId, repository);
    };
    let publishing = false;
    try {
      const record = await create(staging, previousRoot, signal, key);
      recheck();
      if (input.managed && record.publicationRevoked !== false)
        throw new ReferenceSourceError("unavailable", "The native keeper cannot guarantee permanent source withdrawal.");
      const { commit } = input.managed ? await input.managed.access.fetch(record.path!)
        : await transport.fetch({ repository, ref: input.ref, token: input.credential, root: record.path!, signal });
      if (commit !== input.expectedCommit) throw new ReferenceTransportError("unavailable", "The reference moved after resolution; request it again.");
      await transport.checkout({ root: record.path!, commit, signal });
      signal.throwIfAborted();
      recheck();
      const tree = input.managed ? await transport.tree?.({ root: record.path!, commit, signal }) : undefined;
      if (input.managed && !tree) throw new ReferenceSourceError("unavailable", "Managed source tree inspection is unavailable.");
      recheck();
      const sealed = await pool.poolSeal(staging.id, signal);
      const sealedRoot = sealed.root ? { ...sealed.root } : null;
      if (input.managed && (sealed.id !== staging.id || sealed.state !== "sealed" || sealed.purpose !== "source" || !sealed.root))
        throw new ReferenceSourceError("unavailable", "Managed source has no verified sealed root identity.");
      // Authority is read again immediately before the only step readers can observe.
      recheck();
      signal.throwIfAborted();
      await exclusive(key, async () => {
      // The source exposure lock can wait independently of all earlier checks.
      recheck();
      if (input.managed) await input.managed.access.revalidate();
      recheck();
      if (input.managed && (row(domain, repository.canonical, revision)?.root_id ?? null) !== previousRoot)
        throw new ReferenceSourceError("unavailable", "A newer source was published while this acquisition waited; request it again.");
      publishing = true;
      pendingPublications.set(staging.id, { key, view: view.id, name });
      hiddenRoots.delete(staging.id);
      const published = await pool.poolPublish(staging.id, view.id, name, signal, input.managed ? [previousRoot, null] : undefined);
      recheck();
      let acquisition: ReferenceAcquisition | undefined;
      if (input.managed) {
        if (!published.root || published.state !== "sealed" || published.purpose !== "source" || published.id !== staging.id
          || published.root.uuid !== sealedRoot!.uuid || published.root.rootId !== sealedRoot!.rootId || published.root.otransid !== sealedRoot!.otransid)
          throw new ReferenceSourceError("unavailable", "Managed source root changed during publication.");
        acquisition = { id: input.managed.id, brain: options.brain, principalId: input.principalId!, turnId: input.managed.context.turnId,
          identity: input.managed.access.identity, ref: input.ref, commit, tree: tree!, root: published.root,
          grantId: input.managed.access.grantId, networkBytes: input.managed.access.bytes().chargedBytes, at: now() };
      }
      const at = now(), grantId = domain === PUBLIC ? null : (input.grant && isLiveReferenceGrant(db, input.grant.id, at) ? input.grant.id : authorize(domain, input.principalId, repository)!.id);
      if (!await write<boolean>("sourcePublish", dirname(published.path!), domain, repository.canonical, revision, repository.url, name, staging.id, commit, input.ref, grantId, at, acquisition, input.managed?.authority,
        input.managed ? { rootId: previousRoot } : undefined)) {
        recheck();
        throw new ReferenceSourceError("unavailable", "A newer source or authority observation refused this publication; request it again.");
      }
      recheck();
      pendingPublications.delete(staging.id);
      withdrawn.delete(key);
      // A newly validated commit is exposed; the superseded roots leave the view at
      // once, so a later bind reaches only the commit this request validated.
      suspended.delete(key); unsettled.delete(key);
      for (const { id } of db.query("SELECT id FROM reference_roots WHERE domain = ? AND repository = ? AND revision = ? AND state = 'superseded'").all(domain, repository.canonical, revision) as { id: string }[]) {
        if (hiddenRoots.has(id)) continue;
        try { await hideRoot(id); } catch (error) { warn("superseded reference root stays in its view until the next bind hides it", error); }
      }
      });
      return staging.id;
    } catch (error) {
      if (input.managed) await input.managed.containFailure(error, publishing, staging.id)
        .catch(cleanup => warn("reference authority containment is incomplete; bind preparation retries it", cleanup));
      else if (publishing && (failureReason(error) === "denied" || failureReason(error) === "unauthorized"))
        await withdraw(domain, repository.canonical, revision).catch(cleanup => warn("revoked reference publication could not be hidden", cleanup));
      // Staging is never published; its reservation is released through the pool only now that the workers stopped.
      const id = staging.id;
      const state = (db.query("SELECT state FROM reference_roots WHERE id = ?").get(id) as { state: string } | null)?.state;
      if (state === "staging") await releaseRoot(id).catch(cleanup => warn("reference staging release failed; startup recovery retries it", cleanup));
      // A publication whose reply was lost may have moved the name to the released root.
      // Point it back only to a previous root that is exposed under live validation;
      // a suspended or lapsed one stays hidden and its name goes. Otherwise fence the source.
      if (publishing && previousRoot && !input.managed) {
        const previous = row(domain, repository.canonical, revision);
        const exposed = !input.managed && !suspended.has(key) && previous?.root_id === previousRoot && validationLive(previous);
        await exclusive(key, async () => { if (exposed) await pool.poolPublish(previousRoot, view.id, name); else await pool.poolUnpublish(view.id, name); }).catch(async () => {
          await withdraw(domain, repository.canonical, revision).catch(cleanup => warn("reference source could not be fenced after a lost publication", cleanup));
        });
      }
      throw error;
    }
  }

  /** No cross-turn joining: every managed request opens and pays for its own live authority check. */
  async function managedRequest(input: { principalId: string; acquisition?: ReferenceAcquisitionContext; signal?: AbortSignal }, repository: ReferenceRepository, revision: string): Promise<ReferenceSourceLease> {
    const context = input.acquisition;
    if (!context || !context.turnId || !context.current()) throw new ReferenceSourceError("unavailable", "Managed GitHub acquisition needs a live admitted turn and its network budget.");
    const controller = new AbortController(), signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const id = randomUUID();
    const publicFence = authorityFences.get(sourceKey(PUBLIC, repository.canonical, revision)) ?? 0;
    const privateFence = authorityFences.get(sourceKey(privateDomain(input.principalId), repository.canonical, revision)) ?? 0;
    const publicRepositoryFence = authorityFences.get(sourceKey(PUBLIC, repository.canonical, "")) ?? 0;
    const privateRepositoryFence = authorityFences.get(sourceKey(privateDomain(input.principalId), repository.canonical, "")) ?? 0;
    const publicAuthority = sourceAuthority(db, PUBLIC, repository.canonical, revision);
    const privateAuthority = sourceAuthority(db, privateDomain(input.principalId), repository.canonical, revision);
    const assertFence = (domain: string) => {
      if ((authorityFences.get(sourceKey(domain, repository.canonical, revision)) ?? 0) !== (domain === PUBLIC ? publicFence : privateFence)
        || (authorityFences.get(sourceKey(domain, repository.canonical, "")) ?? 0) !== (domain === PUBLIC ? publicRepositoryFence : privateRepositoryFence)
        || !sourceAuthorityCurrent(db, domain === PUBLIC ? publicAuthority : privateAuthority))
        controller.abort(new ReferenceSourceError("unauthorized", "A newer authority observation fenced this reference source."));
    };
    const operation: Operation = { key: sourceKey(PUBLIC, repository.canonical, revision), domain: PUBLIC, principalId: input.principalId,
      grantId: null, controller, joiners: 1, promise: Promise.resolve(undefined as never) };
    const assertTurn = () => { signal.throwIfAborted(); if (closed || !context.current()) throw new ReferenceSourceError("cancelled", "The acquiring turn is no longer available."); };
    let result: ReferenceSourceLease | undefined;
    let accessOpened = false, openAttempted = false, containment: Promise<void> | undefined;
    let publicWithdrawal: Promise<void[]> | undefined;
    const containFailure = (error: unknown, publishing: boolean, publicationId?: string): Promise<void> => {
      if (containment) return containment;
      const reason = failureReason(error), domains = [PUBLIC, privateDomain(input.principalId)];
      let work: Promise<unknown> | undefined;
      if (error instanceof GitHubReferenceMetadataError) {
        work = Promise.all(domains.map(domain => reason === "denied" ? withdrawRepository(domain, repository.canonical, revision)
          : suspendRepository(domain, repository.canonical, revision)));
      } else if (!signal.aborted && context.current() && (reason === "denied" || reason === "unauthorized" || reason === "missing")) {
        work = Promise.all(domains.map(domain => domain === PUBLIC && !accessOpened && publicWithdrawal && reason !== "missing" ? publicWithdrawal
          : reason === "missing" ? withdraw(domain, repository.canonical, revision) : withdrawRepository(domain, repository.canonical, revision)));
      } else if (result && reason === "unavailable") {
        // Wire shutdown may outlive the lease's validation. A newer live
        // validation wins when this expiry cleanup reaches the exposure lock.
        work = suspendSource(operation.domain, repository.canonical, revision, true);
      } else if (publishing && publicationId) {
        // Cleanup is not a new metadata observation. Discard just this
        // attempt; another owner may already have published a valid root.
        return (async () => {
          const root = await write<{ id: string; state: string } | null>("sourceDiscard", publicationId);
          await hideRecordedRoot(root ?? { id: publicationId, state: "staging" });
        })();
      } else if (!signal.aborted && context.current() && openAttempted && !accessOpened) {
        work = Promise.all(domains.map(domain => domain === PUBLIC && publicWithdrawal ? publicWithdrawal : suspendRepository(domain, repository.canonical, revision)));
      }
      if (!work) return Promise.resolve();
      containment = work.then(() => {});
      return containment;
    };
    operation.promise = (async () => {
      const done = await admit(signal);
      let access: GitHubAccess | undefined;
      try {
        assertTurn();
        const maxBytes = Math.min(64 * 1048576, context.egress.remainingBytes());
        if (maxBytes < 1) throw new ReferenceSourceError("capacity", "The acquiring turn has no network allowance left.");
        openAttempted = true;
        access = await options.github!.open({ principalId: input.principalId, repository: repository.url, revision, egress: context.egress, maxBytes, signal,
          current: () => !closed && context.current(),
          withdrawPublic: async () => { await (publicWithdrawal ??= withdrawRepository(PUBLIC, repository.canonical, revision)); } });
        accessOpened = true;
        const currentAccess = access;
        const assertCurrent = () => {
          assertFence(currentAccess.domain === "public" ? PUBLIC : privateDomain(input.principalId));
          assertTurn(); currentAccess.assertCurrent();
        };
        assertCurrent();
        const domain = access.domain === "public" ? PUBLIC : privateDomain(input.principalId);
        Object.assign(operation, { domain, grantId: access.grantId, key: sourceKey(domain, repository.canonical, revision) });
        // Private metadata cannot renew a previously shared public copy.
        if (domain !== PUBLIC) await withdrawRepository(PUBLIC, repository.canonical, revision);
        await withdrawals.get(operation.key);
        assertCurrent();
        const check = await access.resolve();
        assertCurrent();
        if (!check.ok) throw new ReferenceSourceError(check.reason === "missing" ? "missing" : check.reason === "denied" ? "unauthorized" : "unavailable", check.detail);
        const previous = row(domain, repository.canonical, revision);
        const validateCached = async (candidate: SourceRow | null): Promise<string | undefined> => {
          if (!usable(candidate) || candidate.validated_at === 0 || candidate.commit_id !== check.commit || candidate.ref !== check.ref) return;
          return exclusive(operation.key, async () => {
            assertCurrent();
            const current = row(domain, repository.canonical, revision);
            if (!usable(current) || current.root_id !== candidate.root_id || withdrawn.has(operation.key)) return;
            const record = await pool.poolSeal(current.root_id, signal);
            assertCurrent();
            // Hidden/revoked roots never regain publication authority. Fresh
            // acquisition uses a new identity, including across service owners.
            if (record.publicationRevoked !== false || record.view !== (await viewFor(domain)).id) return;
            assertCurrent();
            if (!referenceAcquisitionMatches(db, current.root_id, record, { brain: options.brain, commit: check.commit, ref: check.ref, identity: access!.identity })) return;
            await access!.revalidate();
            assertCurrent();
            if (row(domain, repository.canonical, revision)?.root_id !== current.root_id)
              throw new ReferenceSourceError("unavailable", "A newer source replaced this cached publication; request it again.");
            // Repair a lost alias only while it is absent or still names this
            // root. The native lock preserves a concurrent newer publication.
            await pool.poolPublish(current.root_id, (await viewFor(domain)).id, current.name, signal, [current.root_id, null]);
            assertCurrent();
            const at = now();
            if (!await write<boolean>("sourceValidate", at, at, check.ref, domain, repository.canonical, revision,
              domain === PUBLIC ? publicAuthority : privateAuthority, current.root_id)) {
              assertCurrent();
              throw new ReferenceSourceError("unavailable", "A newer source or authority observation refused this validation; request it again.");
            }
            assertCurrent();
            return current.root_id;
          });
        };
        let selectedRoot = await validateCached(previous);
        if (!selectedRoot) try { selectedRoot = await acquire(signal, { domain, principalId: input.principalId, repository, revision,
          grant: domain === PUBLIC ? null : authorize(domain, input.principalId, repository), credential: null,
          ref: check.ref, expectedCommit: check.commit, previous, managed: { access, context, id,
            authority: domain === PUBLIC ? publicAuthority : privateAuthority, assertCurrent, containFailure } });
        } catch (error) {
          // A concurrent request may have supplied this exact independently
          // resolved target. Validate it on this turn's wire; never join its
          // operation or return a different commit as a fresh result.
          const replacement = row(domain, repository.canonical, revision);
          if (signal.aborted || !context.current() || (failureReason(error) !== "unavailable" && (error as { code?: string }).code !== "unavailable")
            || replacement?.root_id === previous?.root_id) throw error;
          selectedRoot = await validateCached(replacement);
          if (!selectedRoot) throw error;
        }
        assertCurrent();
        const current = row(domain, repository.canonical, revision);
        if (!usable(current) || current.root_id !== selectedRoot) throw new ReferenceSourceError("unavailable", "Managed source publication changed; request it again.");
        // A withdrawn identity is never restored; live cache repair is conditional.
        suspended.delete(operation.key); unsettled.delete(operation.key);
        result = await lease(current, false, null, () => {
          assertTurn(); currentAccess.assertAuthority();
        });
        assertCurrent();
        return { kind: "source", row: current, stale: false, error: null };
      } catch (error) {
        result?.release(); result = undefined;
        await containFailure(error, false);
        if (error instanceof ReferenceTransportError) throw new ReferenceSourceError(error.reason === "denied" ? "unauthorized" : error.reason, error.message);
        throw error;
      } finally { try { await access?.close(); } finally { done(); } }
    })();
    operations.set(id, operation);
    try {
      await operation.promise;
      assertFence(operation.domain);
      assertTurn();
      // The retained guard includes validation, principal and selected
      // grant/credential/recipient authority after wire shutdown completes.
      result!.assertAuthority();
      return result!;
    } catch (error) {
      const held = result;
      let failure = error;
      if (held) {
        // A failed close can hide an authority loss too; contain that loss
        // even when the wire itself never returned successfully.
        try { held.assertAuthority(); } catch (authorityError) { failure = authorityError; }
        held.release();
        await containFailure(failure, false);
      }
      if (failure instanceof ReferenceTransportError) throw new ReferenceSourceError(failure.reason === "denied" ? "unauthorized" : failure.reason, failure.message);
      throw failure;
    }
    finally { operations.delete(id); void settle(...splitKey(operation.key)).catch(error => warn("managed source settle failed", error)); }
  }

  async function request(input: RepositoryInput & { principalId: string; revision: unknown; signal?: AbortSignal; acquisition?: ReferenceAcquisitionContext }): Promise<ReferenceSourceLease> {
    if (closed) throw new ReferenceSourceError("unavailable", "Reference sources are closed.");
    if (input.signal?.aborted) throw new ReferenceSourceError("cancelled", "Reference acquisition request was cancelled.");
    let repository: ReferenceRepository, revision: string;
    try {
      revision = referenceRevision(input.revision);
      if (input.repositoryKey !== undefined) {
        repository = referenceRepositoryFromKey(input.repositoryKey);
        // Keep the actual retained endpoint spelling for other Git hosts too.
        const known = row(privateDomain(input.principalId), repository.canonical, revision) ?? row(PUBLIC, repository.canonical, revision);
        const retainedUrl = input.repositoryUrl ?? known?.url;
        if (retainedUrl) {
          const location = repositoryLocation(retainedUrl);
          if (location.canonical !== repository.canonical) throw new Error("The retained URL does not match its repository key.");
          repository = location;
        } else if (!isManaged(repository.canonical)) throw new ReferenceSourceError("unavailable", "The original repository endpoint is no longer retained; request it explicitly before accessing this worktree.");
      } else repository = repositoryLocation(input.repository);
    }
    catch (error) { if (error instanceof ReferenceSourceError) throw error; throw new ReferenceSourceError("invalid", (error as Error).message); }
    if (isManaged(repository.canonical)) return managedRequest(input, repository, revision);
    const probeKey = `${repository.canonical}\u0000${revision}`;
    const fresh = (source: SourceRow | null) => usable(source) && validationLive(source) && now() < source.refreshed_at + limits.refreshMs;
    if (repository.scheme !== "file" && !((notPublic.get(probeKey) ?? 0) > now())) {
      const current = row(PUBLIC, repository.canonical, revision);
      if (fresh(current) && !withdrawn.has(sourceKey(PUBLIC, repository.canonical, revision)) && !suspended.has(sourceKey(PUBLIC, repository.canonical, revision))) return lease(current!, false, null);
      const outcome = await join(sourceKey(PUBLIC, repository.canonical, revision), { domain: PUBLIC, principalId: null, grantId: null },
        signal => operate(signal, { domain: PUBLIC, principalId: null, repository, revision, grant: null }), input.signal);
      if (outcome.kind === "source") return restored(await lease(outcome.row, outcome.stale, outcome.error), outcome.row);
      // An unanswered public check proves nothing; only a covering grant may try the private path.
      if (outcome.reason === "unavailable" && !coveringReferenceGrant(db, { brain: options.brain, principalId: input.principalId, repository, now: now() }))
        throw new ReferenceSourceError("unavailable", `Reference check failed: ${outcome.detail}`);
    }
    const domain = privateDomain(input.principalId);
    const grant = authorize(domain, input.principalId, repository);
    const current = row(domain, repository.canonical, revision);
    if (fresh(current) && !withdrawn.has(sourceKey(domain, repository.canonical, revision)) && !suspended.has(sourceKey(domain, repository.canonical, revision))) {
      const held = await lease(current!, false, null);
      try { authorize(domain, input.principalId, repository); } catch (error) { held.release(); throw error; }
      return held;
    }
    const outcome = await join(sourceKey(domain, repository.canonical, revision), { domain, principalId: input.principalId, grantId: grant!.id },
      signal => operate(signal, { domain, principalId: input.principalId, repository, revision, grant }), input.signal);
    if (outcome.kind !== "source") throw new ReferenceSourceError("unavailable", outcome.detail);
    // Authority may have ended while the operation ran: a private lease is granted only under a live grant.
    authorize(domain, input.principalId, repository);
    const held = await restored(await lease(outcome.row, outcome.stale, outcome.error), outcome.row);
    try { authorize(domain, input.principalId, repository); } catch (error) { held.release(); throw error; }
    return held;
  }

  /**
   * Take one source out of its view: its name goes and every root it holds
   * returns to the masked roots. Marked before any await, so a request in the
   * meantime validates and publishes it again after this finishes; marked
   * unsettled until the pool confirms, so a bind retries it and refuses until
   * it does.
   */
  function suspendSource(domain: string, repository: string, revision: string, onlyExpired = false, captured?: InvalidatedRoot[]): Promise<void> {
    const key = sourceKey(domain, repository, revision);
    return exclusive(key, async () => {
      const source = row(domain, repository, revision);
      if (onlyExpired && (!source || validationLive(source))) return;
      const priorWithdrawal = withdrawn.get(key);
      // Bind expiry is shared invalidation too, rather than a local flag that
      // another owner can renew while native withdrawal is still outstanding.
      const managed = isManaged(repository);
      const roots = managed ? captured ?? await fenceSource(key)
        : db.query("SELECT id, state FROM reference_roots WHERE domain = ? AND repository = ? AND revision = ?").all(domain, repository, revision) as { id: string; state: string }[];
      if (managed) {
        const current = row(domain, repository, revision);
        const replaced = current?.root_id && !roots.some(root => root.id === current.root_id);
        if (!replaced) { suspended.set(key, { rootId: current?.root_id ?? null, validatedAt: 0 }); unsettled.add(key); }
        for (const root of roots) await hideRecordedRoot(root);
        if (priorWithdrawal && withdrawn.get(key) === priorWithdrawal && roots.some(root => root.id === priorWithdrawal.rootId)) withdrawn.delete(key);
        if (replaced) suspended.delete(key);
        unsettled.delete(key);
        return;
      }
      const pending = [...pendingPublications].filter(([, publication]) => publication.key === key);
      if ((!source?.root_id && !roots.length && !pending.length) || (withholding(source) === "hidden" && !unsettled.has(key) && !pending.length)) return;
      suspended.set(key, { rootId: source?.root_id ?? null, validatedAt: 0 }); unsettled.add(key);
      await write("sourceSuspend", domain, repository, revision);
      if (source) await pool.poolUnpublish((await viewFor(domain)).id, source.name);
      for (const root of roots) await hideRecordedRoot(root);
      for (const [id, publication] of pending) {
        await pool.poolUnpublish(publication.view, publication.name);
        await hideRoot(id);
      }
      // A settled suspension supersedes that earlier failed withdrawal, not
      // any newer observation recorded while native hiding awaited its reply.
      if (priorWithdrawal && withdrawn.get(key) === priorWithdrawal && roots.some(root => root.id === priorWithdrawal.rootId)) withdrawn.delete(key);
      unsettled.delete(key);
    });
  }
  /**
   * Validate a lapsed source again before a new bind exposes it (option 1 of
   * the #2432 ruling). Only the exact published commit can be validated: a
   * moved revision fails here, and a request refreshes it. A denied or missing
   * revision is lost authority, as in a request.
   */
  function revalidate(source: SourceRow & { root_id: string }): Promise<boolean> {
    // A bind occurs before a turn proxy exists. Its lapsed GitHub roots stay
    // hidden until an explicit request can validate on that turn's own budget.
    if (isManaged(source.repository)) return Promise.resolve(false);
    const key = sourceKey(source.domain, source.repository, source.revision);
    const running = revalidations.get(key);
    if (running) return running;
    const work = (async () => {
      try {
        const repository = referenceRepository(source.url);
        const principalId = source.domain === PUBLIC ? null : source.domain.slice("private:".length);
        const grant = principalId === null ? null : coveringReferenceGrant(db, { brain: options.brain, principalId, repository, now: now() });
        if (principalId !== null && !grant) return false;
        // Shared by every bind waiting on it, so no one binder's cancellation decides it.
        // A bind never waits for busy maintenance (#4079): the source is withheld from it instead.
        const check = await transport.resolve({ repository, revision: source.revision, token: token(grant), admissionWaitMs: 0 });
        if (!check.ok) {
          if (check.reason !== "unavailable") {
            if (source.domain === PUBLIC) notPublic.set(`${repository.canonical}\u0000${source.revision}`, now() + limits.validationMs);
            await withdraw(source.domain, source.repository, source.revision);
          }
          return false;
        }
        const current = row(source.domain, source.repository, source.revision);
        if (!usable(current) || current.root_id !== source.root_id || current.commit_id !== check.commit || withdrawn.has(key)) return false;
        if (principalId !== null && !coveringReferenceGrant(db, { brain: options.brain, principalId, repository, now: now() })) return false;
        const at = now();
        await write("sourceRevalidate", at, at, source.domain, source.repository, source.revision, source.root_id);
        return true;
      } catch (error) { warn("reference source revalidation failed; the source is withheld from this bind", error); return false; }
    })().finally(() => revalidations.delete(key));
    revalidations.set(key, work);
    return work;
  }
  /**
   * Before a worker binds a domain's view, everything in it was validated
   * within its lifetime, with a margin for the workers' start (#2432, option 1):
   * every lapsed source is checked again, and one that fails is withheld. A
   * running reader keeps its bind of the view and its open files. No root but a
   * source's current one stays. Anything whose exposure the pool did not
   * confirm refuses the bind until a later bind settles it.
   */
  async function prepare(domain: string, signal?: AbortSignal) {
    try { await settleView(domain, signal); }
    catch (error) {
      if (error instanceof ReferenceSourceError || signal?.aborted) throw error;
      warn("a reference view could not be prepared for a bind", error);
      throw new ReferenceSourceError("unavailable", "A reference source could not be taken out of its view; the view is not bound this turn.");
    }
  }
  async function settleView(domain: string, signal?: AbortSignal) {
    // Another owner can republish a reversibly withdrawn root, including one
    // whose catalog row a failed withdrawal already removed. Reconfirm hiding
    // for this bind rather than inheriting an earlier preparation's receipt.
    for (const { id } of db.query("SELECT id FROM reference_roots WHERE domain = ?").all(domain) as { id: string }[])
      if (hiddenRoots.get(id) === false) hiddenRoots.delete(id);
    const lapsed: (SourceRow & { root_id: string })[] = [];
    for (const source of db.query("SELECT * FROM reference_sources WHERE domain = ? AND root_id IS NOT NULL").all(domain) as SourceRow[]) {
      const key = sourceKey(source.domain, source.repository, source.revision);
      // A withdrawal or an operation decides first; then the source is judged as it is now.
      await abortable(withdrawals.get(key), signal);
      await abortable(Promise.allSettled([...operations.values()].filter(operation => operation.key === key).map(operation => operation.promise)), signal);
      await abortable(exposing.get(key), signal);
      const current = row(source.domain, source.repository, source.revision);
      if (!usable(current)) continue;
      if (unsettled.has(key)) { await abortable(suspendSource(current.domain, current.repository, current.revision), signal, false); continue; }
      const exposure = withholding(current);
      if (exposure === "unknown") { await abortable(suspendSource(current.domain, current.repository, current.revision), signal, false); continue; }
      if (exposure === "hidden" || validFor(current) > BIND_MARGIN()) continue;
      lapsed.push(current);
    }
    // Every lapsed source is checked again, a few at a time; one that fails is withheld.
    const failed: SourceRow[] = [];
    for (let index = 0; index < lapsed.length; index += BIND_CHECKS) {
      const batch = lapsed.slice(index, index + BIND_CHECKS);
      const outcomes = await abortable(Promise.all(batch.map(source => revalidate(source))), signal);
      batch.forEach((source, at) => { if (!outcomes?.[at]) failed.push(source); });
    }
    for (const source of failed) {
      if (withholding(row(source.domain, source.repository, source.revision)) === "hidden") continue;
      await abortable(suspendSource(source.domain, source.repository, source.revision), signal, false);
    }
    // No root other than a source's current one stays in the view: superseded,
    // withdrawn, retained for a worktree, or staging whose publication reply was lost.
    for (const { id, repository, revision, state } of db.query(`SELECT r.id, r.repository, r.revision, r.state FROM reference_roots r WHERE r.domain = ?
      AND NOT EXISTS (SELECT 1 FROM reference_sources s WHERE s.root_id = r.id)`).all(domain) as { id: string; repository: string; revision: string; state: string }[]) {
      if (hiddenRoots.has(id)) continue;
      await abortable(exclusive(sourceKey(domain, repository, revision), async () => {
        // An acquisition may have published it meanwhile as the current root.
        if (db.query("SELECT 1 FROM reference_sources WHERE root_id = ?").get(id)) return;
        if (state === "staging") {
          const record = await nativeRoot(id);
          // Unpublished staging is outside the worker's views already. Taking
          // its publication authority would cancel a valid concurrent fetch.
          if (record?.purpose === "source" && record.view === null && ["reserved", "writable", "sealed"].includes(record.state)) {
            hiddenRoots.set(id, record.publicationRevoked === true);
            return;
          }
        }
        await hideRoot(id);
      }), signal, false);
    }
    for (const key of unsettled) if (key.startsWith(`${domain}\u0000`))
      throw new ReferenceSourceError("unavailable", "A reference source could not be taken out of its view; the view is not bound this turn.");
  }
  /**
   * Whether a view can be bound right now: every source it exposes has at
   * least the bind margin of validation left, no exposure is unconfirmed and no
   * root but a current one is left in it. Read synchronously, at admission.
   */
  function admissible(domain: string): boolean {
    for (const source of db.query("SELECT * FROM reference_sources WHERE domain = ? AND root_id IS NOT NULL").all(domain) as SourceRow[]) {
      const key = sourceKey(source.domain, source.repository, source.revision);
      if (unsettled.has(key)) return false;
      const exposure = withholding(source);
      if (exposure === "unknown") return false;
      if (exposure === "hidden") continue;
      if (validFor(source) <= BIND_MARGIN()) return false;
    }
    return !(db.query(`SELECT r.id FROM reference_roots r WHERE r.domain = ? AND NOT EXISTS (SELECT 1 FROM reference_sources s WHERE s.root_id = r.id)`).all(domain) as { id: string }[])
      .some(({ id }) => !hiddenRoots.has(id));
  }
  /**
   * The lease is taken first, in the same turn as the outcome, so eviction can
   * never pick the source while it is being published again.
   */
  async function restored(held: ReferenceSourceLease, source: SourceRow, assertCurrent?: () => void, signal?: AbortSignal): Promise<ReferenceSourceLease> {
    try { await restore(source, assertCurrent, signal); return held; } catch (error) { held.release(); throw error; }
  }
  /**
   * Publish a source a validated request returned, if it was suspended. Under
   * the source's exposure lock, and only if nothing withdrew, replaced or
   * outlived it meanwhile.
   */
  async function restore(source: SourceRow, assertCurrent?: () => void, signal?: AbortSignal) {
    const key = sourceKey(source.domain, source.repository, source.revision);
    if (!suspended.has(key)) return;
    await exclusive(key, async () => {
      assertCurrent?.();
      if (!suspended.has(key)) return;
      const current = row(source.domain, source.repository, source.revision);
      if (withdrawn.has(key) || withdrawals.has(key) || !usable(current) || current.root_id !== source.root_id || !validationLive(current))
        throw new ReferenceSourceError("unavailable", "The reference source changed while it was being published again; request it again.");
      if (current.domain !== PUBLIC) authorize(current.domain, current.domain.slice("private:".length), referenceRepository(current.url));
      // Until the pool confirms, the exposure is unknown: a failure leaves it for the next bind to take out again.
      unsettled.add(key); hiddenRoots.delete(current.root_id);
      const view = await viewFor(current.domain);
      assertCurrent?.();
      try {
        await pool.poolPublish(current.root_id, view.id, current.name, signal);
        assertCurrent?.();
      } catch (error) {
        // A lost reply or authority after manager admission must not leave a
        // newly restored name behind. A failed cleanup keeps it unsettled.
        await pool.poolUnpublish(view.id, current.name);
        await hideRoot(current.root_id);
        throw error;
      }
      suspended.delete(key); unsettled.delete(key);
    });
  }

  /**
   * Lost authority: cancel in-flight private work and withdraw private sources
   * no live grant covers any more. Readers keep bytes they already read.
   */
  async function revoke(input: { grantIds: readonly string[]; principalIds: readonly string[] }) {
    const principals = new Set(input.principalIds);
    const keys = new Set<string>();
    for (const id of input.grantIds) {
      const owner = db.query("SELECT principal_id FROM reference_grants WHERE id = ?").get(id) as { principal_id: string } | null;
      if (owner) principals.add(owner.principal_id);
    }
    for (const operation of operations.values())
      if (operation.domain !== PUBLIC && (principals.has(operation.principalId!) || input.grantIds.includes(operation.grantId!))) {
        keys.add(operation.key);
        operation.controller.abort(new ReferenceSourceError("unauthorized", "Reference authority was revoked."));
      }
    // A publication submitted before revocation used to be visible here at once.
    // Wait for its receipt so even a source's first publication is withdrawn.
    await write.settled();
    for (const principalId of principals) {
      const sources = db.query(`SELECT repository, revision FROM reference_sources WHERE domain = ?
        UNION SELECT repository, revision FROM reference_roots WHERE domain = ?`)
        .all(privateDomain(principalId), privateDomain(principalId)) as { repository: string; revision: string }[];
      for (const source of sources) keys.add(sourceKey(privateDomain(principalId), source.repository, source.revision));
    }
    for (const key of keys) {
      const [domain, repository, revision] = splitKey(key), principalId = domain.slice("private:".length);
      let covered = false;
      try { covered = Boolean(coveringReferenceGrant(db, { brain: options.brain, principalId, repository: referenceRepositoryFromKey(repository), now: now() })); } catch { covered = false; }
      if (!covered) await withdraw(domain, repository, revision);
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
    // Recovery never renews metadata authority. Invalidated roots stay masked
    // and charged until an explicit request obtains a new authorized root.
    const keep = new Set<string>();
    for (const snapshot of db.query("SELECT * FROM reference_sources WHERE root_id IS NOT NULL").all() as SourceRow[]) {
      const source = row(snapshot.domain, snapshot.repository, snapshot.revision);
      if (!source?.root_id) continue;
      // Another owner can publish or renew validation after the catalog scan.
      // Its publication belongs to a later recovery pass, not this snapshot.
      if (source.root_id !== snapshot.root_id) { keep.add(source.root_id); continue; }
      const record = byId.get(source.root_id!);
      let usableRoot = record?.purpose === "source" && record.state === "sealed";
      if (usableRoot && isManaged(source.repository)) usableRoot = referenceAcquisitionMatches(db, source.root_id!, record!, {
        brain: options.brain, commit: source.commit_id!, ref: source.ref,
      });
      if (usableRoot && source.domain !== PUBLIC) {
        try { usableRoot = Boolean(coveringReferenceGrant(db, { brain: options.brain, principalId: source.domain.slice("private:".length), repository: repositoryLocation(source.url), now: now() })); }
        catch { usableRoot = false; }
      }
      if (usableRoot) {
        if (!validationLive(source) || source.validated_at === 0 || (isManaged(source.repository) && record!.publicationRevoked !== false)) {
          const key = sourceKey(source.domain, source.repository, source.revision);
          const expired = await write<boolean>("sourceSuspend", source.domain, source.repository, source.revision, source.root_id, source.validated_at);
          if (!expired) { keep.add(source.root_id!); continue; }
          suspended.set(key, { rootId: source.root_id, validatedAt: 0 }); unsettled.add(key);
          await hideRoot(source.root_id!);
          unsettled.delete(key);
          keep.add(source.root_id!);
          continue;
        }
        try { await pool.poolPublish(source.root_id!, sourceWrites(db).sourceView(source.domain, randomUUID()).id, source.name, undefined,
          isManaged(source.repository) ? [source.root_id!, null] : undefined); keep.add(source.root_id!); continue; }
        catch (error) { warn("reference source publication could not be restored", error); }
      }
      db.query("UPDATE reference_sources SET root_id = NULL WHERE domain = ? AND repository = ? AND revision = ? AND root_id = ?").run(source.domain, source.repository, source.revision, source.root_id);
    }
    // Everything else this app owns goes: interrupted staging, superseded or
    // withdrawn roots, roots the catalog lost and interrupted deletions.
    for (const record of records) {
      // A root a managed worktree (#2430) was snapshotted from stays: releasing it would free nothing.
      if (record.purpose !== "source" || record.state === "reclaimed" || keep.has(record.id)) continue;
      if (options.dependents?.(record.id)) { retained.push(record.id); continue; }
      try { await pool.poolRelease(record.id); released.push(record.id); }
      catch { retained.push(record.id); }
    }
    for (const { id } of db.query("SELECT id FROM reference_roots").all() as { id: string }[])
      if (byId.has(id) && !keep.has(id) && !retained.includes(id)) db.query("DELETE FROM reference_roots WHERE id = ?").run(id);
    db.query("UPDATE reference_roots SET state = 'published' WHERE id IN (SELECT root_id FROM reference_sources WHERE root_id IS NOT NULL)").run();
    db.query("DELETE FROM reference_sources WHERE root_id IS NULL").run();
    // A root kept only for a worktree is never left where a bound view reaches it.
    for (const id of retained) await hideRoot(id).catch(error => warn("retained reference root stays in its view until the next bind hides it", error));
    return { released, retained };
  }

  return {
    request,
    /** Whether a live grant covers this repository for this principal now; private worktrees (#2430) need one for every access. */
    covers(input: RepositoryInput & { principalId: string }): boolean {
      try { return Boolean(coveringReferenceGrant(db, { brain: options.brain, principalId: input.principalId,
        repository: input.repositoryKey === undefined ? repositoryLocation(input.repository) : referenceRepositoryFromKey(input.repositoryKey), now: now() })); }
      catch { return false; }
    },
    revoke,
    recover,
    /** Host directories a worker of this principal binds; null until something was published there. */
    views(principalId: string): { public: string | null; private: string | null } {
      const path = (domain: string) => (db.query("SELECT host_path FROM reference_views WHERE domain = ?").get(domain) as { host_path: string | null } | null)?.host_path ?? null;
      return { public: path(PUBLIC), private: path(privateDomain(principalId)) };
    },
    /**
     * The public view and this principal's private view, opened if nothing was
     * published there yet, for a worker to bind whole at its start (#2432).
     * A bind is a new mount of everything the view holds, so each view is
     * prepared first: nothing stays whose validation lapsed without a fresh
     * check. A view that cannot be prepared is refused.
     */
    async bindable(principalId: string, signal?: AbortSignal): Promise<{ public: string; private: string }> {
      if (closed) throw new ReferenceSourceError("unavailable", "Reference sources are closed.");
      const open = async (domain: string) => {
        const view = await viewFor(domain);
        if (view.hostPath) return view.hostPath;
        const opened = await pool.poolView(view.id, signal);
        await write("sourceOpenView", opened.path, domain);
        return (await viewFor(domain)).hostPath!;
      };
      const domains = [PUBLIC, privateDomain(principalId)] as const;
      const paths = { public: await open(domains[0]), private: await open(domains[1]) };
      // Preparation waits on checks and pool work, so a source can lapse meanwhile:
      // both views are admitted together, at one instant, or prepared again.
      for (let pass = 0; pass < 2; pass++) {
        for (const domain of domains) await prepare(domain, signal);
        signal?.throwIfAborted();
        if (domains.every(admissible)) return paths;
      }
      // Checking again can push others into the margin when there are many: what is
      // still inside it is withheld instead, which takes only short pool calls.
      for (let round = 0; round < 3; round++) {
        for (const domain of domains)
          for (const source of db.query("SELECT * FROM reference_sources WHERE domain = ? AND root_id IS NOT NULL").all(domain) as SourceRow[]) {
            const key = sourceKey(source.domain, source.repository, source.revision);
            const exposure = withholding(source);
            if ((exposure === "hidden" && !unsettled.has(key)) || (exposure === "live" && validFor(source) > BIND_MARGIN())) continue;
            await abortable(suspendSource(source.domain, source.repository, source.revision), signal, false);
          }
        signal?.throwIfAborted();
        if (domains.every(admissible)) return paths;
      }
      throw new ReferenceSourceError("unavailable", "The reference views could not be settled for this bind; they are not bound this turn.");
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
