import type { WsHost } from "./host.js";

type PendingReceipt = { principalId: string; ready: Promise<void>; claimed: boolean };
const pending = new WeakMap<WsHost, Map<string, PendingReceipt>>();
const MAX_PENDING_RECEIPTS = 256;

/** Host cleanup is complete in memory. Persistence may finish later, without
 * holding idle or the next turn. Keep only a bounded number of pending gates. */
export function prepareClientTurnReceipt(host: WsHost, turnId: string, principalId: string, settled: () => Promise<void>): boolean {
  if (typeof host.activity?.store.writeClientReceipt !== "function") return false;
  let gates = pending.get(host);
  if (!gates) { gates = new Map(); pending.set(host, gates); }
  const existing = gates.get(turnId);
  if (existing) return existing.principalId === principalId;
  if (gates.size >= MAX_PENDING_RECEIPTS) return false;
  const entry: PendingReceipt = { principalId, claimed: false, ready: Promise.resolve().then(settled).catch(() => {}) };
  gates.set(turnId, entry);
  const retained = gates;
  void entry.ready.then(() => { if (retained.get(turnId) === entry) retained.delete(turnId); });
  return true;
}

/** A first owner report may await timing persistence; duplicates and other
 * principals cannot accumulate waiting handlers or consume that owner's slot. */
export function claimClientTurnReceipt(host: WsHost, turnId: string, principalId: string): Promise<void> | false | undefined {
  const entry = pending.get(host)?.get(turnId);
  if (!entry) return undefined;
  if (entry.principalId !== principalId || entry.claimed) return false;
  entry.claimed = true;
  return entry.ready;
}
