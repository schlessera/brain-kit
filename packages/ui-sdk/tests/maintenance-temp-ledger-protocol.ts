/** Test-only process receipts, bounded and independent of pipe chunk boundaries. */
const RECEIPT_TIMEOUT_MS = 5000;
const RECEIPT_BYTES = 64 * 1024;
const DIAGNOSTIC_BYTES = 8192;
type LedgerChild = Pick<Bun.Subprocess<"ignore", "pipe", "pipe">, "pid" | "stdout" | "stderr" | "exited" | "exitCode" | "signalCode">;

async function readLine(stream: ReadableStream<Uint8Array>, deadline: Promise<never>, capture: (bytes: Uint8Array) => void): Promise<string> {
  const reader = stream.getReader();
  const decode = new TextDecoder();
  let text = "", bytes = 0;
  try {
    while (!text.includes("\n")) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) throw new Error(`owned ledger child exited before its receipt: ${text}`);
      capture(result.value);
      bytes += result.value.byteLength;
      if (bytes > RECEIPT_BYTES) throw new Error("owned ledger child exceeded its receipt byte limit");
      text += decode.decode(result.value, { stream: true });
    }
    return text.slice(0, text.indexOf("\n"));
  } finally { reader.releaseLock(); }
}

export async function ledgerLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("owned ledger child did not report its phase")), RECEIPT_TIMEOUT_MS); });
  try { return await readLine(stream, deadline, () => {}); }
  finally { clearTimeout(timeout); }
}

const retain = (previous: Buffer, bytes: Uint8Array) => {
  const tail = bytes.subarray(Math.max(0, bytes.byteLength - DIAGNOSTIC_BYTES));
  return Buffer.concat([previous.subarray(Math.max(0, previous.length - (DIAGNOSTIC_BYTES - tail.byteLength))), tail]);
};
function observeChild(child: LedgerChild) {
  let stderr = Buffer.alloc(0), stderrError: string | undefined, exitStatus: number | null = null;
  const exited = child.exited.then(code => { exitStatus = code; });
  const reader = child.stderr.getReader();
  const drained = (async () => {
    try { for (;;) { const item = await reader.read(); if (item.done) break; stderr = retain(stderr, item.value); } }
    catch (error) { stderrError = String(error); }
    finally { reader.releaseLock(); }
  })();
  return { exited, drained, cancel() { void reader.cancel().catch(() => {}); },
    evidence() { return { exitStatus, exitCode: child.exitCode, signalCode: child.signalCode,
      stderr: stderr.toString("utf8"), ...(stderrError ? { stderrError } : {}) }; } };
}
const observations = new WeakMap<LedgerChild, ReturnType<typeof observeChild>>();

/** Observe before reading: drain stderr without letting an owned child fill its pipe. */
export async function ledgerChildLine(child: LedgerChild, phase: string): Promise<string> {
  let stdout = Buffer.alloc(0);
  let observation = observations.get(child);
  if (!observation) { observation = observeChild(child); observations.set(child, observation); }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("owned ledger child did not report its phase")), RECEIPT_TIMEOUT_MS); });
  try { return await readLine(child.stdout, deadline, bytes => { stdout = retain(stdout, bytes); }); }
  catch (cause) {
    // EOF can precede the exit callback, or a descendant can keep stderr open.
    // Neither diagnostic wait extends the original receipt deadline.
    try { await Promise.race([Promise.all([observation.exited, observation.drained]), deadline]); } catch {}
    const evidence = { phase, pid: child.pid, ...observation.evidence(), stdout: stdout.toString("utf8") };
    observation.cancel();
    throw new Error(`owned ledger child receipt failed: ${JSON.stringify(evidence)}`, { cause });
  } finally { clearTimeout(timeout); }
}
