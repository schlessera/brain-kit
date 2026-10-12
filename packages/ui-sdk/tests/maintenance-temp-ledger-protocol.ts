/** Test-only process receipts, bounded and independent of pipe chunk boundaries. */
export async function ledgerLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decode = new TextDecoder();
  let text = "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("owned ledger child did not report its phase")), 5000); });
  try {
    while (!text.includes("\n")) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) throw new Error(`owned ledger child exited before its receipt: ${text}`);
      text += decode.decode(result.value, { stream: true });
    }
    return text.slice(0, text.indexOf("\n"));
  } finally { clearTimeout(timeout); reader.releaseLock(); }
}
