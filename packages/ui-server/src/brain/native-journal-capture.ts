/** Changed versions only; checkpoint advancement follows the journal commit. */
import { JournalObjectQuarantined } from "./journal-accounting.js";
import { createNativeJournalObserver, type NativeJournalManager, type NativeJournalMetadata, type NativeJournalUnreadable } from "./native-journal-observer.js";
import { freezeNativeJournalPolicy, journalMetadataOnlyPath } from "./native-journal-policy.js";
import { NativeJournalPrivateRead, nativeJournalPermissionDenied, readNativeJournalFile, withNativeJournalFile, type NativeJournalReadContext } from "./native-journal-read.js";
import { verifiedWorkerIdentity, workerIdentityHelper } from "@schlessera/brain-ui-sdk/internal";
import { isJournalSteeringPath, nativeJournalSteeringInputs, type JournalSteeringOptions } from "./journal-steering.js";
import type { JournalSnapshotEntry } from "./journal-snapshot.js";
import type { PhaseTimer } from "../activity/turn-lifecycle.js";

export type NativeJournalPolicy = Awaited<ReturnType<typeof freezeNativeJournalPolicy>>;
export function createNativeJournalCapture(manager: NativeJournalManager, retain: (source: number, bytes: number, signal?: AbortSignal) => Promise<string>, steeringOptions: JournalSteeringOptions = {},
  identity?: { brainPath: string; createTemporary: NativeJournalReadContext["createTemporary"] },
  /**
   * A separate root (#2430) is content only: none of its files configure the
   * brain's agent, and its `.brain-index/` is not the brain's index.
   */
  rootScope: { steering: boolean; index: boolean } = { steering: true, index: true },
  /** A previous checkpoint's release failed after its observation committed (#2872). */
  releaseFailed?: (error: unknown, checkpointId: string) => void) {
  const workerUid = () => {
    if (!identity || !workerIdentityHelper()) return undefined;
    const actual = verifiedWorkerIdentity(identity.brainPath);
    if (!actual) throw new Error("Native private-file recovery requires a successful actual worker identity probe.");
    return actual.workerUid;
  };
  const context = (root: { id: string }, signal?: AbortSignal): NativeJournalReadContext | undefined => {
    const uid = workerUid();
    if (uid === undefined) return undefined;
    if (!manager.readCheckpoint || !identity) throw new Error("Native private-file recovery requires the configured fixed checkpoint reader.");
    return { checkpointId: root.id, workerUid: uid, manager: { readCheckpoint: manager.readCheckpoint.bind(manager) }, signal, createTemporary: identity.createTemporary };
  };
  const observer = createNativeJournalObserver(manager, workerUid, releaseFailed);
  const entry = (metadata: NativeJournalMetadata, policy: NativeJournalPolicy): JournalSnapshotEntry | undefined => {
    const scope = policy.location(metadata.path);
    if (policy.excluded(metadata.path) || !scope || metadata.kind === "directory" || rootScope.index && journalMetadataOnlyPath(metadata.path)) return undefined;
    return { ...metadata, kind: metadata.kind, scope: scope.scope, ignored: policy.ignored(metadata.path) };
  };
  /** Ignored versions keep facts only; the root index has its separate metadata size cap. */
  const retained = (entry: JournalSnapshotEntry) => entry.kind === "file" && !entry.ignored && !entry.metadataOnly;
  return {
    async initialize(signal?: AbortSignal, options: { workspaces?: boolean } = {}) { await observer.initialize(signal, options); },
    async policy(covered: readonly string[] = [], options: { workspaces?: boolean; ordinaryWorkspaces?: boolean } = {}, signal?: AbortSignal): Promise<NativeJournalPolicy> {
      if (options.workspaces !== false) await observer.includeWorkspaces(signal);
      const root = observer.currentRoot();
      return freezeNativeJournalPolicy(observer.ignoreEntries(), (path, maximum) => readNativeJournalFile(root.path, path, maximum, context(root, signal)), covered, { ordinaryWorkspaces: !rootScope.index, ...options, signal });
    },
    allowed(path: string, policy: NativeJournalPolicy): boolean { return !policy.excluded(path) && !!policy.location(path) && !policy.ignored(path) && !(rootScope.index && journalMetadataOnlyPath(path)); },
    eligible(path: string, policy: NativeJournalPolicy): boolean {
      const metadata = observer.get(path);
      return !policy.excluded(path) && !!metadata && metadata.kind === "file" && metadata.bytes <= 64 * 1024 * 1024 && !policy.ignored(path) && !!policy.location(path) && !(rootScope.index && journalMetadataOnlyPath(path));
    },
    /** Exact current sealed before-version; the caller keeps the ordinary policy and storage owner. */
    async retainBefore(path: string, policy: NativeJournalPolicy, signal?: AbortSignal): Promise<JournalSnapshotEntry | undefined> {
      signal?.throwIfAborted();
      const metadata = observer.get(path), root = observer.currentRoot();
      if (!metadata) return undefined;
      if (metadata.bytes > 64 * 1024 * 1024) throw new Error("Selected attachment exceeds the bounded recovery copy size.");
      const result = entry(metadata, policy);
      if (!result || !retained(result)) return result;
      const hash = await withNativeJournalFile(root.path, path, metadata.bytes, context(root, signal),
        file => retain(file.fd, metadata.bytes, signal));
      signal?.throwIfAborted();
      return { ...result, hash };
    },
    async observe(policies: ReadonlyMap<string, NativeJournalPolicy>, signal?: AbortSignal, timing?: PhaseTimer) {
      const observation = await observer.observe(signal, timing, { workspaces: [...policies.values()].some(policy => !policy.excluded("workspaces")) });
      const end = timing?.("observe_capture");
      try {
        const captured = new Map<string, string>();
        const capturing = new Map<string, Promise<void>>();
        const unreadable = new Map<string, NativeJournalUnreadable>(observation.unreadable.map(item => [item.path, item]));
        async function version(metadata: NativeJournalMetadata | null, policy: NativeJournalPolicy, root: { id: string; path: string }, deferPrivate = false): Promise<JournalSnapshotEntry | undefined> {
          if (!metadata) return undefined;
          const result = entry(metadata, policy);
          if (!result || !retained(result)) return result;
          const key = `${root.id}:${metadata.inode}`;
          // Join an in-flight alias before consulting the completed hash. A
          // failed name releases the slot so the next alias can try its own path.
          while (capturing.has(key)) await capturing.get(key);
          let hash = captured.get(key);
          if (!hash) {
            const completion = Promise.withResolvers<void>();
            capturing.set(key, completion.promise);
            try {
              const privateRead = context(root, signal), started = performance.now();
              try { hash = await withNativeJournalFile(root.path, metadata.path, metadata.bytes, privateRead ? { ...privateRead, deferPrivate } : undefined,
                file => retain(file.fd, metadata.bytes, signal)); }
              catch (error) {
                if (error instanceof NativeJournalPrivateRead) throw error;
                if (error instanceof JournalObjectQuarantined) {
                  unreadable.set(metadata.path, { path: metadata.path, bytes: metadata.bytes, mode: metadata.mode, kind: metadata.kind, reason: "retained_object_corrupt", ms: 0 });
                  return result;
                }
                if (!privateRead || !nativeJournalPermissionDenied(error)) throw error;
                unreadable.set(metadata.path, { path: metadata.path, bytes: metadata.bytes, mode: metadata.mode, kind: metadata.kind, reason: "worker_reader_unavailable", ms: Math.max(0, Math.round(performance.now() - started)) });
                return result;
              }
              // A failed name says nothing about another hardlink's accessibility.
              captured.set(key, hash);
            } finally { capturing.delete(key); completion.resolve(); }
          }
          return { ...result, hash };
        }
        const changes = new Map<string, { path: string; before?: JournalSnapshotEntry; after?: JournalSnapshotEntry }[]>();
        for (const [turnId, policy] of policies) {
          const versions = [];
          // Bound descriptor/memory use while allowing the ready reservations
          // and completions of this window to share their durable commits.
          for (let offset = 0; offset < observation.changes.length; offset += 16) {
            const deferred: typeof observation.changes = [];
            const captureChange = async (change: typeof observation.changes[number], deferPrivate: boolean) => {
              signal?.throwIfAborted();
              if (change.before?.kind === "directory" && change.after?.kind === "directory") return undefined;
              if (change.before?.kind === change.after?.kind && change.before?.mode === change.after?.mode &&
                change.before?.stamp === change.after?.stamp && change.before?.target === change.after?.target) return undefined;
              // Deferred private reads run one side at a time, after all direct
              // copies in this batch: one fixed reader and one temporary copy.
              if (!deferPrivate) {
                const before = await version(change.before, policy, observation.beforeRoot);
                const after = await version(change.after, policy, observation.afterRoot);
                return before || after ? { path: change.path, before, after } : undefined;
              }
              const pair = await Promise.allSettled([version(change.before, policy, observation.beforeRoot, true), version(change.after, policy, observation.afterRoot, true)]);
              const failure = pair.find(side => side.status === "rejected");
              if (failure?.status === "rejected") throw failure.reason;
              const [before, after] = pair.map(side => side.status === "fulfilled" ? side.value : undefined);
              return before || after ? { path: change.path, before, after } : undefined;
            };
            const batch = await Promise.allSettled(observation.changes.slice(offset, offset + 16).map(async change => {
              try { return await captureChange(change, true); }
              catch (error) { if (error instanceof NativeJournalPrivateRead) { deferred.push(change); return undefined; } throw error; }
            }));
            const failure = batch.find(item => item.status === "rejected");
            if (failure?.status === "rejected") throw failure.reason;
            for (const item of batch) if (item.status === "fulfilled" && item.value) versions.push(item.value);
            for (const change of deferred) { const item = await captureChange(change, false); if (item) versions.push(item); }
          }
          changes.set(turnId, versions);
        }
        // Classification retains no unchanged bytes. Its metadata inventory is
        // shared; bounded configuration reads come from the two pinned roots.
        const changed = new Map(observation.changes.map(change => [change.path, change.after]));
        const steering = new Map<string, Awaited<ReturnType<typeof nativeJournalSteeringInputs>> & { inventoried: boolean }>();
        for (const [turnId, policy] of policies) {
          const snapshots: { entries: JournalSnapshotEntry[]; missing: never[] }[] = [];
          const roots = new Map<string, { id: string; path: string }>();
          const classified = (metadata: NativeJournalMetadata, root: typeof observation.beforeRoot) => {
            const value = entry(metadata, policy);
            if (!value) return undefined;
            const stamp = `${root.id}:${value.stamp}`;
            roots.set(stamp, root);
            return { ...value, stamp };
          };
          if (rootScope.steering && observation.changes.length) {
            for (const [root, after] of [[observation.beforeRoot, false], [observation.afterRoot, true]] as const) {
              const entries: JournalSnapshotEntry[] = [];
              const append = (metadata: NativeJournalMetadata) => {
                const value = classified(metadata, root); if (value) entries.push(value);
              };
              for (const metadata of observer.steeringEntries()) {
                const replacement = after && changed.has(metadata.path) ? changed.get(metadata.path) : metadata;
                if (replacement) append(replacement);
              }
              if (after) for (const change of observation.changes)
                if (!change.before && change.after && isJournalSteeringPath(change.path)) append(change.after);
              snapshots.push({ entries, missing: [] });
            }
          }
          const classifiedSteering = await nativeJournalSteeringInputs(snapshots,
            (item, maximum) => { const root = roots.get(item.stamp)!; return readNativeJournalFile(root.path, item.path, maximum, context(root, signal)); },
            path => {
              // Match the before/after inventory union without cloning the full
              // metadata map. Deleted references remain classifiable from before.
              const after = changed.get(path);
              if (after) return classified(after, observation.afterRoot);
              const before = observer.get(path);
              return before ? classified(before, changed.has(path) ? observation.beforeRoot : observation.afterRoot) : undefined;
            }, steeringOptions);
          for (const item of unreadable.values()) if (item.kind === "directory" || item.bytes === null) classifiedSteering.unavailable.push(item.path);
          steering.set(turnId, { ...classifiedSteering, inventoried: snapshots.length > 0 });
        }
        end?.();
        // Without a change the inventory is not taken: an empty set then says
        // nothing about the brain's configuration (#3257).
        return { changes, metadataChanges: observation.changes, steering, unreadable: [...unreadable.values()], stats: observation.stats, indexBytes: rootScope.index ? observation.indexBytes : 0, commit: observation.commit, abort: observation.abort };
      } catch (error) { await observation.abort().catch(() => {}); throw error; }
    },
    releases() { return observer.releases(); },
    releasesSettled() { return observer.releasesSettled(); },
    close() { return observer.close(); },
  };
}
