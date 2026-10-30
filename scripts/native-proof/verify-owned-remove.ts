/** Internal fixture receipt; no package or supported integration contract. */
export function verifyOwnedRemove(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const receipt = value as { outcome?: unknown; attempts?: unknown };
  if (receipt.outcome !== "removed" || !Array.isArray(receipt.attempts) || receipt.attempts.length < 1 || receipt.attempts.length > 50) return false;
  const attempts = receipt.attempts;
  let priorEnd = 0, firstBusy: number | undefined;
  return attempts.every((raw: unknown, index: number) => {
    if (!raw || typeof raw !== "object") return false;
    const row = raw as { startNs: number; endNs: number; errno: unknown; error?: unknown };
    if (!Number.isSafeInteger(row.startNs) || !Number.isSafeInteger(row.endNs) || row.startNs < priorEnd || row.endNs < row.startNs) return false;
    if (firstBusy !== undefined && (row.startNs - priorEnd < 20_000_000 || row.startNs - firstBusy >= 1_000_000_000)) return false;
    priorEnd = row.endNs;
    if (index === attempts.length - 1) return row.errno === null && row.error === undefined;
    if (row.errno !== 16 || typeof row.error !== "string" || row.error.length === 0) return false;
    firstBusy ??= row.endNs;
    return true;
  });
}
