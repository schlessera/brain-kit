/** Real physical-write date binding; never changes any runtime clock or mtime. */
export const actualWriteDayUTC = () => new Date().toISOString().slice(0, 10);
export function assertWriteDayUTC(expected: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expected) || expected !== actualWriteDayUTC()) {
    throw Error("Actual UTC fixture write day differs from the reviewed preparation");
  }
  return expected;
}
export const previousWriteDayUTC = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

/** Refuse native work near midnight; an already running tool is not an atomic clock transaction. */
export function assertNativeWriteWindowUTC(expected: string, deadlineMs: number) {
  assertWriteDayUTC(expected);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300000 || Date.now() + deadlineMs + 30000 >= Date.parse(`${expected}T00:00:00Z`) + 86400000) {
    throw Error("Insufficient real UTC day remaining for bounded native deadline and owned drain");
  }
}
