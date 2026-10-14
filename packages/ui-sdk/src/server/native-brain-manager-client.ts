/** Unprivileged client of the one configured native store's host Unix service. */
import { isAbsolute } from "node:path";
import { request as unixRequest } from "node:http";
import { Readable } from "node:stream";
import { NativeBrainManagerError, nativeManagerRequest, NATIVE_CONTROL_BYTES, NATIVE_DATA_CHUNK_BYTES, NATIVE_MANAGER_OPERATION_TIMEOUT_MS, NATIVE_MANAGER_MAX_DELTA_BYTES,
  type NativeCheckpoint, type NativeManagerErrorCode, type NativeManagerReady, type NativeManagerRequest, type NativeRecoveryRecord } from "./native-brain-manager-protocol.js";

export interface NativeDeltaStream {
  stream: ReadableStream<Uint8Array>;
  /** Must be awaited in addition to the parser's native CRC/END/EOF validation. */
  completed: Promise<{ exitCode: 0; bytes: number }>;
}
async function boundedJson(response: Response): Promise<any> {
  if (!response.body) throw new NativeBrainManagerError("unavailable", "Native manager returned no response body.");
  const reader = response.body.getReader(), pieces: Uint8Array[] = [];
  let length = 0;
  try { for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    length += value.byteLength;
    if (length > NATIVE_CONTROL_BYTES) throw new NativeBrainManagerError("unavailable", "Native manager control response exceeded its bound.");
    pieces.push(value);
  } } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Decode broker framing only; native stream semantics belong to the journal parser. */
export function decodeNativeDelta(body: ReadableStream<Uint8Array>, maxBytes: number): NativeDeltaStream {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Native delta bound must be a positive finite integer.");
  const reader = body.getReader(); let pending = new Uint8Array(0), count = 0, terminal = false, settled = false;
  let resolve!: (value: { exitCode: 0; bytes: number }) => void, reject!: (error: unknown) => void;
  const completed = new Promise<{ exitCode: 0; bytes: number }>((yes, no) => { resolve = yes; reject = no; });
  // A caller may be parsing first; retain the rejection until it awaits completion.
  void completed.catch(() => {});
  const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
  async function exact(length: number): Promise<Uint8Array> {
    while (pending.byteLength < length) {
      const { done, value } = await reader.read();
      if (done) throw new NativeBrainManagerError("unavailable", "Native delta ended before its broker completion.");
      const joined = new Uint8Array(pending.byteLength + value.byteLength); joined.set(pending); joined.set(value, pending.byteLength); pending = joined;
    }
    const answer = pending.slice(0, length); pending = pending.slice(length); return answer;
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (terminal) {
          const tail = pending.byteLength ? { done: false } : await reader.read();
          if (!tail.done) throw new NativeBrainManagerError("unavailable", "Native delta contained bytes after broker completion.");
          settled = true; resolve({ exitCode: 0, bytes: count }); controller.close(); reader.releaseLock(); return;
        }
        const header = await exact(5), type = header[0], length = new DataView(header.buffer).getUint32(1);
        if ((type !== 1 && type !== 2) || length === 0 || length > (type === 1 ? NATIVE_DATA_CHUNK_BYTES : NATIVE_CONTROL_BYTES))
          throw new NativeBrainManagerError("unavailable", "Malformed native delta broker frame.");
        const payload = await exact(length);
        if (type === 1) {
          count += length;
          if (count > maxBytes) throw new NativeBrainManagerError("capacity", "Native delta exceeded the client's maxDeltaBytes transport work bound; configure it for this host workload. This is not a history quota.");
          controller.enqueue(payload); return;
        }
        const end = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
        if (end?.ok === false && ["unsupported", "capacity", "unavailable", "unknown", "released", "invalid"].includes(end.code) && typeof end.message === "string")
          throw new NativeBrainManagerError(end.code, end.message);
        if (end?.ok !== true || end?.exitCode !== 0 || end?.bytes !== count || Object.keys(end).sort().join(",") !== "bytes,exitCode,ok")
          throw new NativeBrainManagerError("unavailable", "Native manager did not prove successful delta completion.");
        terminal = true;
        // Continue to natural EOF even for an empty native delta.
        const tail = pending.byteLength ? { done: false } : await reader.read();
        if (!tail.done) throw new NativeBrainManagerError("unavailable", "Native delta contained bytes after broker completion.");
        settled = true; resolve({ exitCode: 0, bytes: count }); controller.close(); reader.releaseLock();
      } catch (error) { fail(error); await reader.cancel(error); controller.error(error); }
    },
    async cancel(reason) { fail(reason ?? new NativeBrainManagerError("unknown", "Native delta consumer cancelled.")); await reader.cancel(reason); },
  });
  return { stream, completed };
}

export function createNativeBrainManagerClient(input: { socketPath: string; timeoutMs?: number; maxDeltaBytes?: number }) {
  const options = Object.freeze({ ...input, timeoutMs: input.timeoutMs ?? NATIVE_MANAGER_OPERATION_TIMEOUT_MS, maxDeltaBytes: input.maxDeltaBytes ?? NATIVE_MANAGER_MAX_DELTA_BYTES });
  if (!isAbsolute(options.socketPath) || options.socketPath.includes("\0")) throw new Error("Native manager needs one absolute Unix socket path.");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || !Number.isSafeInteger(options.maxDeltaBytes) || options.maxDeltaBytes <= 0)
    throw new Error("Native manager client needs finite positive timeout and delta bounds.");
  async function call(request: NativeManagerRequest, signal?: AbortSignal): Promise<Response> {
    nativeManagerRequest.parse(request);
    try {
      const cancellation = signal ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs);
      const response = await new Promise<Response>((resolve, reject) => {
        // socketPath selects AF_UNIX. There is deliberately no host, port, URL, proxy or TCP fallback.
        const operation = unixRequest({ socketPath: options.socketPath, path: "/native-brain", method: "POST", signal: cancellation,
          headers: { "content-type": "application/json" } }, incoming => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          resolve(new Response(Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>, { status: incoming.statusCode, headers }));
        });
        operation.once("error", reject); operation.end(JSON.stringify(request));
      });
      if (!response.ok) {
        const result = await boundedJson(response);
        throw new NativeBrainManagerError(result.code as NativeManagerErrorCode, typeof result.message === "string" ? result.message : "Native manager refused the operation.");
      }
      return response;
    } catch (error) {
      if (error instanceof NativeBrainManagerError) throw error;
      // A cancelled/lost request can have committed in the broker. Never imply absence or release ownership.
      throw new NativeBrainManagerError("unknown", `Native manager outcome is unknown; reconcile the same checkpoint identity. ${String(error)}`);
    }
  }
  async function control(request: NativeManagerRequest, signal?: AbortSignal): Promise<any> {
    try { return await boundedJson(await call(request, signal)); }
    catch (error) {
      if (error instanceof NativeBrainManagerError) throw error;
      throw new NativeBrainManagerError("unknown", `Native manager receipt is unreadable; reconcile the same checkpoint identity. ${String(error)}`);
    }
  }
  return {
    ready: async (signal?: AbortSignal): Promise<NativeManagerReady> => control({ operation: "ready" }, signal),
    checkpoint: async (id: string, signal?: AbortSignal): Promise<NativeCheckpoint> => control({ operation: "checkpoint", id }, signal),
    release: async (id: string, signal?: AbortSignal): Promise<{ id: string; state: "deleted" }> => control({ operation: "release", id }, signal),
    listRecovery: async (after: string | null = null, signal?: AbortSignal): Promise<{ records: NativeRecoveryRecord[]; next: string | null }> => control({ operation: "listRecovery", after }, signal),
    delta: async (from: string, to: string, signal?: AbortSignal): Promise<NativeDeltaStream> => {
      const response = await call({ operation: "delta", from, to }, signal);
      if (response.headers.get("content-type") !== "application/x-brain-native-delta" || !response.body)
        throw new NativeBrainManagerError("unavailable", "Native manager returned no framed delta.");
      return decodeNativeDelta(response.body, options.maxDeltaBytes);
    },
  };
}
