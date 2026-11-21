/** Credentialed vector refreshes are separate updates with the same causing turns. */
import { coalesced } from "./host-execution.js";
import { recordIndexUpdate, type IndexUpdateReceipt } from "./index-update-receipt.js";

export function credentialedIndexRefresh(options: {
  index(): Promise<unknown>;
  receipt(receipt: IndexUpdateReceipt, turns: string[]): unknown;
  cancellation: readonly AbortSignal[];
  report(error: unknown): void;
}) {
  const turns = new Set<string>();
  const work = coalesced(() => {
    const causing = [...turns]; turns.clear();
    return recordIndexUpdate(options.index, receipt => options.receipt(receipt, causing), options.cancellation)
      .catch(error => { if (!options.cancellation.some(signal => signal.aborted && signal.reason === error)) throw error; });
  }, options.report);
  return Object.assign((ids: string[] = []) => { for (const id of ids) turns.add(id); work(); }, { idle: () => work.idle() });
}
