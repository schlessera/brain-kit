/** The outgoing-snapshot list a draft save leaves (#3588): pure, no database. */
import type { DraftOutgoing, DraftSnapshot, DraftSnapshotWrite } from "@schlessera/brain-ui-sdk/protocol";

import { invalid } from "./errors.js";

/** The two fields of a save that name its snapshots. */
interface SnapshotListInput {
  /** The single-slot write (#3153): create or dispatch its snapshot, or remove the one `outgoing` shows (null). */
  outgoing?: DraftOutgoing | null;
  /** The whole outgoing snapshot list (#3588). Absent keeps it. Not combined with `outgoing`. */
  snapshots?: DraftSnapshotWrite[];
}

/** The single-slot view: the newest snapshot still held or unconfirmed. */
export function legacyOutgoing(snapshots: readonly DraftSnapshot[]): DraftSnapshot | null {
  for (let i = snapshots.length - 1; i >= 0; i--) if (snapshots[i]!.state !== "returned") return snapshots[i]!;
  return null;
}

/** Every file a draft's snapshots own, once each. */
export function snapshotFiles(snapshots: readonly DraftSnapshotWrite[]): string[] {
  return [...new Set(snapshots.flatMap((s) => s.fileIds))];
}

/**
 * The list a save leaves, from the stored list and what the request names.
 * Edits happen in place and never need a free slot; `created` lists the new
 * snapshots, which the caller counts against the chat's capacity.
 */
export function nextSnapshots(stored: readonly DraftSnapshot[], input: SnapshotListInput, at: number): { list: DraftSnapshot[]; created: DraftSnapshot[] } {
  if (input.snapshots !== undefined && input.outgoing !== undefined) throw invalid("Send either outgoing or snapshots, not both.");
  if (input.snapshots === undefined && input.outgoing === undefined) return { list: [...stored], created: [] };
  const byId = new Map(stored.map((s) => [s.snapshotId, s]));
  if (input.outgoing === null) {
    // The single-slot clear removes the snapshot that slot shows, as #3153 did.
    const shown = legacyOutgoing(stored);
    return { list: stored.filter((s) => s !== shown), created: [] };
  }
  const writes: DraftSnapshotWrite[] = input.outgoing !== undefined
    ? (() => {
      // The single-slot write addresses the snapshot of its request.
      const o = input.outgoing;
      const existing = stored.find((s) => s.requestId === o.requestId);
      const write = { snapshotId: existing?.snapshotId ?? o.requestId, requestId: o.requestId, text: o.text, fileIds: o.fileIds, state: o.state };
      return existing ? stored.map((s) => (s === existing ? write : s)) : [...stored, write];
    })()
    : input.snapshots!;
  const seen = new Set<string>();
  const requests = new Set<string>();
  const list: DraftSnapshot[] = [];
  const created: DraftSnapshot[] = [];
  for (const write of writes) {
    if (seen.has(write.snapshotId)) throw invalid("A snapshot is listed twice.");
    if (requests.has(write.requestId)) throw invalid("Two snapshots name the same requestId.");
    seen.add(write.snapshotId); requests.add(write.requestId);
    const prior = byId.get(write.snapshotId);
    if (!prior) {
      if (write.state === "returned") throw invalid("A new snapshot is held or dispatched.");
      if (stored.some((s) => s.requestId === write.requestId)) throw invalid("Another snapshot already sends this requestId.");
      const snapshot = { ...write, fileIds: [...write.fileIds], createdAt: at };
      list.push(snapshot); created.push(snapshot);
      continue;
    }
    // Nothing of a snapshot changes but its state, and a held one's files.
    if (write.requestId !== prior.requestId || write.text !== prior.text) throw invalid("A snapshot's text and requestId do not change.");
    const sameFiles = write.fileIds.length === prior.fileIds.length && write.fileIds.every((id, i) => id === prior.fileIds[i]);
    if (!sameFiles && prior.state !== "held") throw invalid("Only a held snapshot's files change.");
    const allowed = write.state === prior.state
      || (prior.state === "held" && (write.state === "returned" || write.state === "dispatched"))
      || (prior.state === "dispatched" && write.state === "returned");
    if (!allowed) throw invalid(`A ${prior.state} snapshot cannot become ${write.state}.`);
    list.push({ ...prior, fileIds: [...write.fileIds], state: write.state });
  }
  // Leaving a snapshot out deletes it, which only a returned one may be.
  for (const prior of stored) {
    if (!seen.has(prior.snapshotId) && prior.state !== "returned") {
      throw invalid(`A ${prior.state} snapshot is not deleted; return it first.`);
    }
  }
  return { list, created };
}
