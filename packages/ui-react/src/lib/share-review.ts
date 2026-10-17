import { bindStoredShare, pruneStoredShares } from "@schlessera/brain-ui-sdk/internal/client";
import { getShareStore, type StoredShare } from "@schlessera/brain-ui-sdk/share-target";
import { SHARE_STASH_TTL_MS } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiRoot } from "../root.js";
import { accountPartition, type PartitionHandle } from "./local-partitions.js";

export const SHARE_REVIEW_PREFIX = "share:review:";
export type ShareReview = { record: StoredShare; confirmed: boolean };

/** Several mounted consumers may share one root; ownership belongs to the root. */
export type ShareReviewSession = {
  account: string;
  consumers: number;
  controller: AbortController;
  owners: Map<string, () => void>;
  waiting: StoredShare | null;
  pending: Set<string>;
  activeUpload: { record: StoredShare; controller: AbortController; owner: AbortSignal } | null;
};
const sessions = new WeakMap<BrainUiRoot, ShareReviewSession>();

function stopSession(root: BrainUiRoot, session: ShareReviewSession): void {
  if (session.controller.signal.aborted) return;
  session.controller.abort();
  session.activeUpload?.controller.abort();
  for (const [id, release] of session.owners) { root.stores.share.getState().remove(id); release(); }
  session.owners.clear(); session.waiting = null; session.pending.clear();
  if (sessions.get(root) === session) root.stores.share.getState().setBusy(false);
}

export function acquireShareReviewSession(root: BrainUiRoot, account: string): ShareReviewSession {
  let session = sessions.get(root);
  if (session && session.account !== account) stopSession(root, session);
  if (!session || session.controller.signal.aborted) {
    session = { account, consumers: 0, controller: new AbortController(), owners: new Map(), waiting: null, pending: new Set(), activeUpload: null };
    sessions.set(root, session);
  }
  session.consumers++;
  return session;
}

export function releaseShareReviewSession(root: BrainUiRoot, session: ShareReviewSession, owner: AbortSignal): void {
  if (session.activeUpload?.owner === owner) {
    session.waiting = session.activeUpload.record;
    session.activeUpload.controller.abort();
  }
  if (--session.consumers === 0) stopSession(root, session);
}

/** A native lock lives until unmount or tab termination, without a lease timer. */
export function holdShareReview(id: string, signal: AbortSignal, run: () => Promise<void>): Promise<void> {
  if (!navigator.locks) return Promise.reject(new Error("This browser cannot safely recover shared content. The original is kept on this device."));
  return navigator.locks.request(`brain-ui:share-review:${id}`, { ifAvailable: true }, async lock => {
    if (!lock || signal.aborted) return;
    await run();
  });
}

export function shareReviewPartition(root: BrainUiRoot): PartitionHandle {
  if (!root.partitions) throw new Error("Device storage is required to review shared content. The original is kept.");
  return root.partitions.openAccount();
}

/** Copy/commit before removing the worker original; the journal fences crashes. */
export async function recoverShareReview(root: BrainUiRoot, id: string): Promise<ShareReview | undefined> {
  const partition = shareReviewPartition(root);
  const account = root.stores.connection.getState().accountKey!;
  const generation = root.partitions!.writerGeneration(accountPartition(account));
  const epoch = root.authLock.epoch();
  const key = `${SHARE_REVIEW_PREFIX}${id}`;
  let review = await partition.get(key) as ShareReview | undefined;
  if (!review) {
    if (root.stores.connection.getState().accountKey !== account) return;
    const record = await bindStoredShare(id, { account, generation }, () => root.stores.connection.getState().accountKey === account && root.authLock.epoch() === epoch && root.partitions!.writerGeneration(accountPartition(account)) === generation);
    if (!record) return;
    review = { record, confirmed: false };
    await partition.put(key, review);
  }
  // Also completes a transfer whose page died after the account write.
  await getShareStore().delete(id);
  if (Date.now() - review.record.receivedAt > SHARE_STASH_TTL_MS) {
    await partition.write([{ delete: key }]);
    return;
  }
  return review;
}

export async function shareReviewIds(root: BrainUiRoot): Promise<string[]> {
  const rows = await shareReviewPartition(root).list(SHARE_REVIEW_PREFIX);
  await pruneStoredShares(getShareStore(), SHARE_STASH_TTL_MS);
  const originals = await getShareStore().list();
  return [...new Set([...rows.map(row => row.key.slice(SHARE_REVIEW_PREFIX.length)), ...originals.map(row => row.id)])];
}
