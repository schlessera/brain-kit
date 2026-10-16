import { hashScope, type Source } from "./history-model.js";
import type { SharedStorageScan, SharedScan } from "./shared-scan.js";
import type { StorageWriteReport } from "./history-store.js";
import { projectStorageTree, sortStorageRows } from "./tree.js";
import { storageReferences } from "./process.js";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { StorageFilter, StoragePage, StorageStatus, StorageReferenceEvidence, StorageTreeFilter, StorageTreePage, StorageSnapshot } from "@schlessera/brain-ui-sdk/protocol";
import { collectStorage, storageTotals, STORAGE_SERVER_LIMITS, type StorageCollection, type StorageCollectOptions } from "./collect.js";
export class StorageUnavailable extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 429 | 503, message: string) { super(message); }
}
export function createStorageCoordinator(options: Omit<StorageCollectOptions, "salt"> & {
  authorized(principalId: string): boolean;
  salt?: string;
  shared?: SharedStorageScan;
  onCollection?(collection: StorageCollection, source: Source): void;
  onFailure?(at: number): void;
  onWrite?(report: StorageWriteReport): void;
  /** Host/backend owners resolve exact roots; this callback never receives request data. */
  storesNow?(): { stores: StorageCollectOptions["stores"]; unavailable: NonNullable<StorageCollectOptions["unavailable"]> };
}) {
  const salt = options.salt ?? randomBytes(32).toString("hex");
  let current: StorageCollection | null = null, previous: StorageCollection | null = null;
  let active: { id: string; principal: string; controller: AbortController; promise: Promise<void>; lease?: SharedScan } | null = null;
  let lastAttempt = 0, closed = false;
  let referenceJob: { controller: AbortController; promise: Promise<StorageReferenceEvidence> } | null = null;
  let lastFailure: { scanId: string; at: number; reason: string } | null = null;
  const authorized = (principal: string) => { if (!options.authorized(principal)) throw new StorageUnavailable(403, "Storage requires current human-owner access."); };
  const prune = () => { if (previous && Date.now() - previous.summary.observedAt > 600_000) previous = null; if (current && Date.now() - current.summary.observedAt > 600_000) current = null; };
  const status = (principal: string): StorageStatus => {
    authorized(principal); prune();
    return { version: 1, state: active ? "scanning" : "idle", activeScanId: active?.id ?? null, snapshot: current?.summary ?? null, previous: previous?.summary ?? null, lastFailure, limits: STORAGE_SERVER_LIMITS };
  };
  const digest = (value: string) => createHmac("sha256", salt).update(value).digest("base64url");
  function collection(principal: string, id: string): StorageCollection {
    authorized(principal); prune();
    const result = [current, previous].find(value => value?.summary.id === id);
    if (!result) throw new StorageUnavailable(404, "Storage observation expired or unavailable; refresh.");
    return result;
  }
  const api = {
    status,
    /** Internal owning-operation report. No request route accepts these fields. */
    ownerWrite(rootIdentity: string, target: string, resource: StorageWriteReport["resource"], outcome: StorageWriteReport["outcome"]) {
      const key = (value: string) => createHmac("sha256", salt).update(value).digest("hex").slice(0, 32);
      const root = key(`root:${rootIdentity}`), latest = [current, previous].filter(value => value !== null).sort((a, b) => b.summary.observedAt - a.summary.observedAt)[0];
      const capacity = latest?.summary.capacities.find(value => value.rootIds.includes(root));
      const report: StorageWriteReport = { identity: capacity?.id ?? key(`unresolved:${rootIdentity}`), rootScope: hashScope(capacity ? [...capacity.rootIds].sort() : [root]), target: key(`write:${rootIdentity}:${target}`), resource, outcome, at: Date.now() };
      try { options.onWrite?.(report); } catch { /* Telemetry cannot alter the owning operation's result. */ }
    },
    start(principal: string, fresh = false, source: Source = 1): StorageStatus {
      authorized(principal);
      if (closed) throw new StorageUnavailable(503, "Storage is shutting down.");
      if (active) return status(principal);
      if (!fresh && Date.now() - lastAttempt < 5_000) throw new StorageUnavailable(429, "Wait before refreshing Storage again.");
      const dynamic = options.storesNow?.() ?? { stores: [], unavailable: [] };
      const scope = hashScope({ brain: options.brainPath, stores: [...options.stores, ...dynamic.stores], git: options.gitRoots ?? [], unavailable: [...options.unavailable ?? [], ...dynamic.unavailable] });
      let lease: SharedScan | undefined;
      const requestId = randomUUID();
      if (options.shared) {
        try {
          const acquired = options.shared.acquire(principal, requestId, scope, source, fresh);
          if (!acquired) return status(principal);
          lease = acquired;
        } catch (error) {
          authorized(principal);
          const message = error instanceof Error ? error.message : "storage-lease-unavailable";
          throw new StorageUnavailable(message === "storage-scan-cooldown" ? 429 : message === "storage-scan-other-scope-busy" ? 409 : 503, message);
        }
      }
      lastAttempt = Date.now();
      const id = lease?.id ?? requestId, controller = new AbortController();
      const job = { id, principal, controller, promise: Promise.resolve(), lease };
      active = job;
      const timeout = setTimeout(() => controller.abort(), STORAGE_SERVER_LIMITS.milliseconds);
      const revocation = setInterval(() => {
        if (!options.authorized(principal)) controller.abort();
        if (lease?.owner) { try { options.shared!.check(lease); } catch { controller.abort(); } }
      }, 250);
      job.promise = (async () => {
        try {
          controller.signal.throwIfAborted();
          if (lease?.owner) await options.shared!.reap(lease);
          const result = lease && !lease.owner ? await options.shared!.wait(lease, controller.signal)
            : await collectStorage({ ...options, stores: [...options.stores, ...dynamic.stores], unavailable: [...options.unavailable ?? [], ...dynamic.unavailable], salt,
              ...(lease ? { workerLease: { register: (pid: number) => options.shared!.register(lease!, pid), unregister: (pid: number) => options.shared!.unregister(lease!, pid) } } : {}) }, id, controller.signal);
          authorized(principal); controller.signal.throwIfAborted();
          if (lease?.owner) {
            let cached = await options.shared!.publish(lease, result);
            authorized(principal); controller.signal.throwIfAborted();
            if (!options.shared!.finish(lease, cached, false, result.summary.observedAt)) {
              cached = await options.shared!.publish(lease, result);
              authorized(principal); controller.signal.throwIfAborted();
              if (!options.shared!.finish(lease, cached, false, result.summary.observedAt)) throw Error("storage-scan-authority-lost");
            }
          }
          if (!lease || lease.owner) { try { options.onCollection?.(result, source); } catch { /* History failure cannot remove an inventory result. */ } }
          if (result.summary.coverage === "complete" || !current || current.summary.coverage !== "complete") { previous = current; current = result; }
          else previous = result; // A partial refresh never erases the last complete observation.
          if (current && previous && current.bytes + previous.bytes > STORAGE_SERVER_LIMITS.cacheBytes) previous = null;
          lastFailure = null;
        } catch {
          lastFailure = { scanId: id, at: Date.now(), reason: controller.signal.aborted || !options.authorized(principal) ? "cancelled-or-revoked" : "collection-unavailable" };
          if (!lease || lease.owner) {
            try { options.onFailure?.(lastFailure.at); } catch { /* Last valid history stays intact. */ }
            if (lease) { try { options.shared!.finish(lease, false, true, lastFailure.at); } catch { /* Preserve unresolved lease authority for recovery. */ } }
          }
        }
        finally { clearTimeout(timeout); clearInterval(revocation); if (active === job) active = null; }
      })();
      return status(principal);
    },
    cancel(principal: string, id: string): StorageStatus {
      authorized(principal);
      if (active?.id !== id) throw new StorageUnavailable(409, "That scan is no longer active.");
      active.controller.abort();
      if (active.lease) options.shared!.cancel({ ...active.lease, principal });
      return status(principal);
    },
    page(principal: string, id: string, filter: StorageFilter): StoragePage {
      const value = collection(principal, id);
      const { cursor, ...criteria } = filter;
      const filterKey = JSON.stringify(criteria);
      let offset = 0;
      if (cursor) {
        if (cursor.length > 2048) throw new StorageUnavailable(400, "Invalid Storage cursor.");
        const [encoded, signature, extra] = cursor.split(".");
        const expected = Buffer.from(digest(encoded ?? "")), actual = Buffer.from(signature ?? "");
        if (extra || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new StorageUnavailable(400, "Invalid Storage cursor.");
        let token: { id: string; filter: string; offset: number; expires: number };
        try { token = JSON.parse(Buffer.from(encoded!, "base64url").toString()); } catch { throw new StorageUnavailable(400, "Invalid Storage cursor."); }
        if (token.id !== id || token.filter !== filterKey || token.expires < Date.now() || !Number.isSafeInteger(token.offset) || token.offset < 0) throw new StorageUnavailable(409, "Storage cursor expired or filters changed.");
        offset = token.offset;
      }
      const owners = new Map(value.summary.roots.map(root => [root.id, root.owner]));
      const matches = value.entries.filter(entry => (!criteria.rootId || entry.rootId === criteria.rootId)
        && (criteria.parentId === undefined || entry.parentId === (criteria.parentId || null))
        && (!criteria.owner || criteria.owner === "all" || owners.get(entry.rootId) === criteria.owner)
        && (!criteria.type || entry.kind === "file" && /\.pdf$/i.test(entry.name))
        && (!criteria.search || entry.name.toLowerCase().includes(criteria.search.toLowerCase()))
        && (criteria.largerThan === undefined || entry.kind === "file" && entry.logical !== null && entry.logical > criteria.largerThan));
      if (criteria.sort || criteria.direction || criteria.metric) sortStorageRows(matches, criteria, entry => entry[criteria.metric ?? "allocated"]);
      const page = matches.slice(offset, offset + STORAGE_SERVER_LIMITS.page), next = offset + page.length;
      let nextCursor: string | null = null;
      if (next < matches.length) { const encoded = Buffer.from(JSON.stringify({ id, filter: filterKey, offset: next, expires: Date.now() + 60_000 })).toString("base64url"); nextCursor = `${encoded}.${digest(encoded)}`; }
      const fileEntries = matches.filter(entry => entry.kind === "file");
      const logicalSum = fileEntries.reduce((sum, entry) => sum + BigInt(entry.logical ?? 0), 0n);
      const fileLogicalTotal = fileEntries.some(entry => entry.logical === null) || logicalSum > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(logicalSum);
      return { scanId: id, fileLogicalTotal, entries: page, nextCursor, stale: Date.now() >= value.summary.staleAfter, matched: matches.length, totals: storageTotals(matches, value.summary.coverage === "complete") };
    },
    tree(principal: string, id: string, filter: StorageTreeFilter): StorageTreePage {
      const value = collection(principal, id), { cursor, ...criteria } = filter, filterKey = "tree:" + JSON.stringify(criteria);
      let offset = 0;
      if (cursor) {
        if (cursor.length > 2048) throw new StorageUnavailable(400, "Invalid Storage cursor.");
        const [encoded, signature, extra] = cursor.split("."), expected = Buffer.from(digest(encoded ?? "")), actual = Buffer.from(signature ?? "");
        if (extra || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new StorageUnavailable(400, "Invalid Storage cursor.");
        let token: { id: string; filter: string; offset: number; expires: number };
        try { token = JSON.parse(Buffer.from(encoded!, "base64url").toString()); } catch { throw new StorageUnavailable(400, "Invalid Storage cursor."); }
        if (token.id !== id || token.filter !== filterKey || token.expires < Date.now() || !Number.isSafeInteger(token.offset) || token.offset < 0) throw new StorageUnavailable(409, "Storage cursor expired or filters changed.");
        offset = token.offset;
      }
      let projected: ReturnType<typeof projectStorageTree>;
      try { projected = projectStorageTree(value, criteria); } catch { throw new StorageUnavailable(503, "Storage hierarchy unavailable; refresh this observation."); }
      const nodes = projected.nodes.slice(offset, offset + STORAGE_SERVER_LIMITS.page), next = offset + nodes.length;
      let nextCursor: string | null = null;
      if (next < projected.nodes.length) { const encoded = Buffer.from(JSON.stringify({ id, filter: filterKey, offset: next, expires: Date.now() + 60_000 })).toString("base64url"); nextCursor = `${encoded}.${digest(encoded)}`; }
      return { ...projected, nodes, scanId: id, nextCursor, matched: projected.nodes.length, stale: Date.now() >= value.summary.staleAfter };
    },
    async references(principal: string, id: string, entryId: string): Promise<StorageReferenceEvidence> {
      const value = collection(principal, id), entry = value.entries.find(item => item.id === entryId);
      if (!entry || entry.kind !== "file") throw new StorageUnavailable(404, "File observation unavailable.");
      if (referenceJob) throw new StorageUnavailable(429, "A reference inspection is already running.");
      const root = value.summary.roots.find(item => item.id === entry.rootId);
      const prefix = root?.category === "scratch" ? ".brain/scratch/" : root?.category === "workspace" ? "workspaces/" : "";
      const evidence: StorageReferenceEvidence = { entryId, observedAt: Date.now(), state: "unavailable", sources: [], truncated: false, newestIndexedAt: null, freshness: "unchecked", unchecked: ["unindexed files", "unresolved links", "current source changes", "external consumers"] };
      if (!root || !["content", "scratch", "workspace"].includes(root.category)) return evidence;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5_000);
      const revoked = setInterval(() => { if (!options.authorized(principal)) controller.abort(); }, 250);
      const job = { controller, promise: Promise.resolve(evidence) };
      referenceJob = job;
      job.promise = (async () => {
        try {
          const result = await storageReferences(options.brainPath, prefix + entry.path, controller.signal) as { ok?: boolean; value?: { sources?: Array<{path:string;indexedAt:string}>; truncated?: boolean }; snapshot?: {newestIndexedAt?:string|null} };
          if (result.ok && Array.isArray(result.value?.sources) && result.value.sources.length <= 200 && result.value.sources.every(source => typeof source.path === "string" && !source.path.startsWith("/") && !source.path.split("/").includes("..") && typeof source.indexedAt === "string")) {
            evidence.state = "observed"; evidence.sources = result.value.sources; evidence.truncated = result.value.truncated === true; evidence.newestIndexedAt = result.snapshot?.newestIndexedAt ?? null;
          }
        } catch { /* Explicit unavailable evidence, never a fabricated zero-reference verdict. */ }
        finally { clearTimeout(timer); clearInterval(revoked); if (referenceJob === job) referenceJob = null; }
        authorized(principal); return evidence;
      })();
      return job.promise;
    },
    /** Operation evidence joins an active live observation; it never schedules a duplicate scan behind it. */
    async measure(principal: string, signal: AbortSignal): Promise<StorageSnapshot | null> {
      signal.throwIfAborted(); authorized(principal);
      const joined = active !== null;
      const id = active?.id ?? api.start(principal, true, 2).activeScanId;
      const job = active;
      if (!job || !id) return null;
      let rejectAbort: (reason: unknown) => void = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const abort = () => { if (!joined && active === job) job.controller.abort(); rejectAbort(signal.reason ?? Error("Storage observation cancelled.")); };
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      try { await Promise.race([job.promise, cancelled]); signal.throwIfAborted(); authorized(principal); return [current, previous].find(value => value?.summary.id === id)?.summary ?? null; }
      finally { signal.removeEventListener("abort", abort); }
    },
    async idle() { await active?.promise; },
    async close() { closed = true; active?.controller.abort(); referenceJob?.controller.abort(); await Promise.allSettled([active?.promise, referenceJob?.promise]); current = null; previous = null; },
  };
  return api;
}
export type StorageCoordinator = ReturnType<typeof createStorageCoordinator>;
