/** Changed versions only; checkpoint advancement follows the journal commit. */
import { createNativeJournalObserver, type NativeJournalManager, type NativeJournalMetadata, type NativeJournalUnreadable } from "./native-journal-observer.js";
import { freezeNativeJournalPolicy, journalPathScope } from "./native-journal-policy.js";
import { nativeJournalPermissionDenied, readNativeJournalFile, withNativeJournalFile, type NativeJournalReadContext } from "./native-journal-read.js";
import { verifiedWorkerIdentity, workerIdentityHelper } from "@schlessera/brain-ui-sdk/internal";
import { isJournalSteeringPath, nativeJournalSteeringInputs, type JournalSteeringOptions } from "./journal-steering.js";
import type { JournalSnapshotEntry } from "./journal-snapshot.js";

export type NativeJournalPolicy = Awaited<ReturnType<typeof freezeNativeJournalPolicy>>;
export function createNativeJournalCapture(manager: NativeJournalManager, retain: (source: number, bytes: number, signal?: AbortSignal) => Promise<string>, steeringOptions: JournalSteeringOptions = {},
  identity?: { brainPath: string; createTemporary: NativeJournalReadContext["createTemporary"] }) {
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
  const observer = createNativeJournalObserver(manager, workerUid);
  const entry = (metadata: NativeJournalMetadata, policy: NativeJournalPolicy): JournalSnapshotEntry | undefined => {
    const scope = journalPathScope(metadata.path);
    if (!scope || metadata.kind === "directory") return undefined;
    return { ...metadata, kind: metadata.kind, scope: scope.scope, ignored: policy.ignored(metadata.path) };
  };
  return {
    async initialize(signal?: AbortSignal) { await observer.initialize(signal); },
    async policy(covered: readonly string[] = []): Promise<NativeJournalPolicy> {
      const root = observer.currentRoot();
      return freezeNativeJournalPolicy(observer.ignoreEntries(), (path, maximum) => readNativeJournalFile(root.path, path, maximum, context(root)), covered);
    },
    allowed(path: string, policy: NativeJournalPolicy): boolean { return !!journalPathScope(path) && !policy.ignored(path); },
    eligible(path: string, policy: NativeJournalPolicy): boolean {
      const metadata = observer.get(path);
      return !!metadata && metadata.kind === "file" && metadata.bytes <= 64 * 1024 * 1024 && !policy.ignored(path) && !!journalPathScope(path);
    },
    /** Exact current sealed before-version; the caller keeps the ordinary policy and storage owner. */
    async retainBefore(path: string, policy: NativeJournalPolicy, signal?: AbortSignal): Promise<JournalSnapshotEntry | undefined> {
      signal?.throwIfAborted();
      const metadata = observer.get(path), root = observer.currentRoot();
      if (!metadata) return undefined;
      if (metadata.bytes > 64 * 1024 * 1024) throw new Error("Selected attachment exceeds the bounded recovery copy size.");
      const result = entry(metadata, policy);
      if (!result || result.ignored || result.kind !== "file") return result;
      const hash = await withNativeJournalFile(root.path, path, metadata.bytes, context(root, signal),
        file => retain(file.fd, metadata.bytes, signal));
      signal?.throwIfAborted();
      return { ...result, hash };
    },
    async observe(policies: ReadonlyMap<string, NativeJournalPolicy>, signal?: AbortSignal) {
      const observation = await observer.observe(signal);
      try {
        const captured = new Map<string, string>();
        const unreadable = new Map<string, NativeJournalUnreadable>(observation.unreadable.map(item => [item.path, item]));
        async function version(metadata: NativeJournalMetadata | null, policy: NativeJournalPolicy, root: { id: string; path: string }): Promise<JournalSnapshotEntry | undefined> {
          if (!metadata) return undefined;
          const result = entry(metadata, policy);
          if (!result || result.ignored || result.kind !== "file") return result;
          const key = `${root.id}:${metadata.inode}`;
          let hash = captured.get(key);
          if (!hash) {
            const privateRead = context(root, signal), started = performance.now();
            try { hash = await withNativeJournalFile(root.path, metadata.path, metadata.bytes, privateRead, file => retain(file.fd, metadata.bytes, signal)); }
            catch (error) {
              if (!privateRead || !nativeJournalPermissionDenied(error)) throw error;
              unreadable.set(metadata.path, { path: metadata.path, bytes: metadata.bytes, mode: metadata.mode, kind: metadata.kind, reason: "worker_reader_unavailable", ms: Math.max(0, Math.round(performance.now() - started)) });
              return result;
            }
            captured.set(key, hash);
          }
          return { ...result, hash };
        }
        const changes = new Map<string, { path: string; before?: JournalSnapshotEntry; after?: JournalSnapshotEntry }[]>();
        for (const [turnId, policy] of policies) {
          const versions = [];
          for (const change of observation.changes) {
            signal?.throwIfAborted();
            if (change.before?.kind === "directory" && change.after?.kind === "directory") continue;
            if (change.before?.kind === change.after?.kind && change.before?.mode === change.after?.mode &&
              change.before?.stamp === change.after?.stamp && change.before?.target === change.after?.target) continue;
            const before = await version(change.before, policy, observation.beforeRoot);
            const after = await version(change.after, policy, observation.afterRoot);
            if (before || after) versions.push({ path: change.path, before, after });
          }
          changes.set(turnId, versions);
        }
        // Classification retains no unchanged bytes. Its metadata inventory is
        // shared; bounded configuration reads come from the two pinned roots.
        const changed = new Map(observation.changes.map(change => [change.path, change.after]));
        const snapshots: { entries: JournalSnapshotEntry[]; missing: never[] }[] = [];
        const roots = new Map<string, { id: string; path: string }>();
        const included = { ignored(path: string) { return [...policies.values()].every(policy => policy.ignored(path)); } } as NativeJournalPolicy;
        const classified = (metadata: NativeJournalMetadata, root: typeof observation.beforeRoot) => {
          const value = entry(metadata, included);
          if (!value) return undefined;
          const stamp = `${root.id}:${value.stamp}`;
          roots.set(stamp, root);
          return { ...value, stamp };
        };
        if (policies.size && observation.changes.length) {
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
        const steering = await nativeJournalSteeringInputs(snapshots,
          (item, maximum) => { const root = roots.get(item.stamp)!; return readNativeJournalFile(root.path, item.path, maximum, context(root, signal)); },
          path => {
            // Match the before/after inventory union without cloning the full
            // metadata map. Deleted references remain classifiable from before.
            const after = changed.get(path);
            if (after) return classified(after, observation.afterRoot);
            const before = observer.get(path);
            return before ? classified(before, changed.has(path) ? observation.beforeRoot : observation.afterRoot) : undefined;
          }, steeringOptions);
        for (const item of unreadable.values()) if (item.kind === "directory" || item.bytes === null) steering.unavailable.push(item.path);
        return { changes, steering, unreadable: [...unreadable.values()], stats: observation.stats, commit: observation.commit, abort: observation.abort };
      } catch (error) { await observation.abort().catch(() => {}); throw error; }
    },
    close() { return observer.close(); },
  };
}
