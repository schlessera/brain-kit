/** Literal response capture completes only after physical EOF or bounded cancellation. */
import { createHash } from "node:crypto";
export interface WireCapture {
  rawResponseBase64?: string; rawResponseSha?: string; responseBytes?: number;
  responseEof?: boolean; responseClosed?: boolean; responseCancelled?: boolean; closureTimedOut?: boolean;
}
export async function captureWire(response: Response, target: WireCapture, save: () => void, signal?: AbortSignal | null, deadlineMs = 10000) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 10 || deadlineMs > 10000) throw Error("Invalid physical response deadline");
  const parts: Uint8Array[] = []; let timer: ReturnType<typeof setTimeout> | undefined;
  const reader = response.body?.getReader();
  if (!reader) { target.responseEof = true; target.responseClosed = true; save(); return new Uint8Array(); }
  let reject!: (reason: unknown) => void;
  const refusal = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
  const onAbort = () => reject(signal?.reason ?? Error("Physical request aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  timer = setTimeout(() => reject(Error("Physical response deadline expired")), deadlineMs);
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), refusal]);
      if (next.done) { target.responseEof = true; target.responseClosed = true; save(); return new Uint8Array(Buffer.concat(parts)); }
      parts.push(next.value.slice()); const bytes = Buffer.concat(parts);
      target.rawResponseBase64 = bytes.toString("base64"); target.rawResponseSha = createHash("sha256").update(bytes).digest("hex"); target.responseBytes = bytes.length;
      save(); // Before any decode, JSON parse, or provider retry.
    }
  } catch (error) {
    target.responseCancelled = true;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const done = await Promise.race([Promise.all([reader.cancel(error).then(() => true, () => true), reader.closed.then(() => true, () => true)]).then(() => true), new Promise<boolean>(resolve => { cancelTimer = setTimeout(() => resolve(false), 2000); })]);
      target.responseClosed = done; target.closureTimedOut = !done; save();
    } finally { if (cancelTimer !== undefined) clearTimeout(cancelTimer); }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (target.responseClosed) reader.releaseLock();
  }
}

export async function fetchPhysical<T>(dispatch: () => Promise<T>, signal?: AbortSignal | null) {
  let reject!: (reason:unknown)=>void;
  const refused=new Promise<never>((_resolve,no)=>{reject=no;});
  const onAbort=()=>reject(signal?.reason ?? Error("Physical dispatch aborted"));
  signal?.addEventListener("abort",onAbort,{once:true});
  try { if(signal?.aborted){onAbort();return await refused;} return await Promise.race([dispatch(),refused]); }
  finally {signal?.removeEventListener("abort",onAbort);}
}
