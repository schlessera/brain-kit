/** A caller deadline is never evidence that an owned storage operation stopped. */
export const STORAGE_SETTLEMENT_MS = 10_000;

export class StorageSettlementIndeterminate extends Error {
  constructor(readonly operation: string, readonly cleanup?: Promise<unknown>) {
    super(`${operation} did not settle within ${STORAGE_SETTLEMENT_MS} ms; persistence and cleanup remain indeterminate and owned.`);
    this.name = "StorageSettlementIndeterminate";
  }
}

/** Observe the original promise through completion, including after this wait rejects. */
export function withinStorageBudget<T>(pending: Promise<T>, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StorageSettlementIndeterminate(operation, pending)), STORAGE_SETTLEMENT_MS);
    void pending.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
