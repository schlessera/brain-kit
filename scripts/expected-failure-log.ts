/**
 * Marks the output of a deliberate negative control in a job log.
 *
 * Some proofs run a control that must fail for one exact reason, then verify
 * that failure. Its output is evidence and stays in the log, which outlives
 * the job's artifacts. Every line it prints carries `EXPECTED_FAILURE_PREFIX`,
 * so neither a reader nor `failingLines` (`scripts/pr-status.ts`) takes its
 * designed failure for the job's. The verdict on the control is printed by
 * the parent without the prefix: a control that fails for any other reason
 * still fails the job in plain text (#2921).
 */
export const EXPECTED_FAILURE_PREFIX = "expected-failure control | ";

/** Copies `stream` to `write`, prefixing every line, including a final line without a newline. */
export async function relayExpectedFailure(stream: ReadableStream<Uint8Array>, write: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop()!;
    for (const line of lines) write(`${EXPECTED_FAILURE_PREFIX}${line}\n`);
  }
  pending += decoder.decode();
  if (pending) write(`${EXPECTED_FAILURE_PREFIX}${pending}\n`);
}

/** Runs a negative control with every line it prints marked, and returns its exit code. */
export async function runExpectedFailureControl(argv: string[]): Promise<number> {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  await Promise.all([
    relayExpectedFailure(child.stdout, text => process.stdout.write(text)),
    relayExpectedFailure(child.stderr, text => process.stderr.write(text)),
  ]);
  return await child.exited;
}
