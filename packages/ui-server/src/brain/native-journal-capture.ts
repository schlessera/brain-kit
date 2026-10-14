/** Changed versions only; checkpoint advancement follows the journal commit. */
import { createNativeJournalObserver, type NativeJournalManager, type NativeJournalMetadata } from "./native-journal-observer.js";
import { freezeNativeJournalPolicy, journalPathScope } from "./native-journal-policy.js";
import { openNativeJournalFile, readNativeJournalFile } from "./native-journal-read.js";
import { isJournalSteeringPath, nativeJournalSteeringInputs } from "./journal-steering.js";
import type { JournalSnapshotEntry } from "./journal-snapshot.js";

export type NativeJournalPolicy = Awaited<ReturnType<typeof freezeNativeJournalPolicy>>;
export function createNativeJournalCapture(manager: NativeJournalManager, retain: (source: number, bytes: number) => Promise<string>) {
  const observer = createNativeJournalObserver(manager);
  const entry = (metadata: NativeJournalMetadata, policy: NativeJournalPolicy): JournalSnapshotEntry | undefined => {
    const scope = journalPathScope(metadata.path);
    if (!scope || metadata.kind === "directory") return undefined;
    return { ...metadata, kind: metadata.kind, scope: scope.scope, ignored: policy.ignored(metadata.path) };
  };
  return {
    async initialize(signal?: AbortSignal) { await observer.initialize(signal); },
    async policy(covered: readonly string[] = []): Promise<NativeJournalPolicy> {
      const root = observer.currentRoot();
      return freezeNativeJournalPolicy(observer.ignoreEntries(), (path, maximum) => readNativeJournalFile(root.path, path, maximum), covered);
    },
    async observe(policies: ReadonlyMap<string, NativeJournalPolicy>, signal?: AbortSignal) {
      const observation = await observer.observe(signal);
      try {
        const captured = new Map<string, string>();
        async function version(metadata: NativeJournalMetadata | null, policy: NativeJournalPolicy, root: { id: string; path: string }): Promise<JournalSnapshotEntry | undefined> {
          if (!metadata) return undefined;
          const result = entry(metadata, policy);
          if (!result || result.ignored || result.kind !== "file") return result;
          const key = `${root.id}:${metadata.inode}`;
          let hash = captured.get(key);
          if (!hash) {
            const file = await openNativeJournalFile(root.path, metadata.path);
            try { hash = await retain(file.fd, metadata.bytes); } finally { await file.close(); }
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
        const roots = new Map<string, string>();
        const included = { ignored(path: string) { return [...policies.values()].every(policy => policy.ignored(path)); } } as NativeJournalPolicy;
        const classified = (metadata: NativeJournalMetadata, root: typeof observation.beforeRoot) => {
          const value = entry(metadata, included);
          if (!value) return undefined;
          const stamp = `${root.id}:${value.stamp}`;
          roots.set(stamp, root.path);
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
          (item, maximum) => readNativeJournalFile(roots.get(item.stamp)!, item.path, maximum),
          path => {
            // Match the before/after inventory union without cloning the full
            // metadata map. Deleted references remain classifiable from before.
            const after = changed.get(path);
            if (after) return classified(after, observation.afterRoot);
            const before = observer.get(path);
            return before ? classified(before, changed.has(path) ? observation.beforeRoot : observation.afterRoot) : undefined;
          });
        return { changes, steering, stats: observation.stats, commit: observation.commit, abort: observation.abort };
      } catch (error) { await observation.abort().catch(() => {}); throw error; }
    },
    close() { return observer.close(); },
  };
}
