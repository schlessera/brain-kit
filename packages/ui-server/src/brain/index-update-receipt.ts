/** Generated index history is one host receipt per update, never file versions. */
export interface IndexUpdateReceipt {
  generation: string; durationMs: number; outcome: "complete" | "failed" | "index_capacity";
  cause?: string;
}
export async function recordIndexUpdate<T>(work: () => Promise<T>, record: (receipt: IndexUpdateReceipt) => void): Promise<T> {
  const generation = crypto.randomUUID(), started = performance.now();
  let receipt: IndexUpdateReceipt;
  try {
    const result = await work();
    receipt = { generation, durationMs: performance.now() - started, outcome: "complete" };
    return result;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    receipt = { generation, durationMs: performance.now() - started,
      outcome: /ENOSPC|EDQUOT|No space left on device|Disk quota exceeded|staging capacity|temporary storage is busy/i.test(cause) ? "index_capacity" : "failed", cause: cause.slice(0, 2000) };
    throw error;
  } finally {
    try { record(receipt!); } catch { /* Receipt diagnostics cannot replace the index result. */ }
  }
}
