/** Preserve complete native bytes before SDK parsing, including late/unterminated EOF. */
import { appendFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
export function captureNative(path: string, observe: (line: string) => void, ended: () => void) {
  const decoder = new StringDecoder("utf8"); let pending = "";
  function lines(text: string) {
    pending += text; const complete = pending.split("\n"); pending = complete.pop()!;
    for (const line of complete) if (line.trim()) observe(line);
  }
  return new Transform({ transform(chunk, _encoding, callback) {
    try { appendFileSync(path, chunk); lines(decoder.write(chunk)); callback(null, chunk); }
    catch (error) { callback(error as Error); }
  }, flush(callback) {
    try { lines(decoder.end()); if (pending.trim()) observe(pending); ended(); callback(); }
    catch (error) { callback(error as Error); }
  } });
}
export async function drainOwned(child: { kill: (signal: NodeJS.Signals) => unknown }, closed: Promise<void>, timeoutMs = 5000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([closed.then(() => true), new Promise<false>(resolve => timer = setTimeout(() => resolve(false), timeoutMs))]);
  clearTimeout(timer);
  if (!done) child.kill("SIGKILL");
  await closed; // Actual child close also drains stdout/stderr; no invented timeout success.
  return { forcedKill: !done };
}
