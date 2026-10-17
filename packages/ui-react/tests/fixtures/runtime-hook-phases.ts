/** Bounded, content-free setup receipts for hosted hook timeouts (#2279).
 * These observations impose no deadline and never suppress a rejection.
 */
export function runtimeHookPhases(file: string) {
  const report = (stage: string, event: string, extra: Record<string, unknown> = {}) =>
    console.error(JSON.stringify({ kind: "runtime-hook", file, pid: process.pid,
      at: Date.now(), elapsedMs: performance.now(), stage, event, ...extra }));
  async function phase<T>(stage: string, run: () => Promise<T>): Promise<T> {
    report(stage, "start");
    try {
      const value = await run();
      report(stage, "complete");
      return value;
    } catch (error) {
      report(stage, "rejected");
      throw error;
    }
  }
  async function child(stage: string, child: {
    pid: number; stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>;
  }, consume: (stream: ReadableStream<Uint8Array>) => Promise<string> =
    (stream) => new Response(stream).text()): Promise<[string, string, number]> {
    const details = { childPid: child.pid };
    report(stage, "start", details);
    async function output(stream: ReadableStream<Uint8Array>, channel: string) {
      // Observations contain only fixed progress labels and numeric metadata.
      // A caller with an existing relay can retain its own output semantics.
      let pending = "";
      const decoder = new TextDecoder();
      let progressEvents = 0;
      const progress = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop()!.slice(-256);
          for (const line of lines) {
            if (channel === "stdout" && progressEvents < 100 && /^Building packages\/[a-z0-9-]+\.\.\.$/.test(line)) {
              progressEvents++;
              report(stage, "build-progress", { ...details, package: line.slice(18, -3) });
            }
          }
        },
      });
      try {
        const text = await consume(stream.pipeThrough(progress));
        report(stage, `${channel}-complete`, { ...details, bytes: Buffer.byteLength(text) });
        return text;
      } catch (error) {
        report(stage, `${channel}-rejected`, details);
        throw error;
      }
    }
    const result = await Promise.all([output(child.stdout, "stdout"), output(child.stderr, "stderr"),
      child.exited.then((code) => { report(stage, "exit", { ...details, code }); return code; })]);
    report(stage, "complete", details);
    return result;
  }
  return { phase, child };
}
