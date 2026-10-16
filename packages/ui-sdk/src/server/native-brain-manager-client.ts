/** Unprivileged client of the one configured native store's host Unix service. */
import { isAbsolute } from "node:path";
import { request as unixRequest } from "node:http";
import { Readable } from "node:stream";
import { consumeNativeStageAuthority, consumeNativeCheckpointRead, nativeCheckpointReaderPath, type NativeCheckpointReadTicket } from "./native-checkpoint-reader.js";
import { nativeCheckpointId } from "./native-brain-manager-protocol.js";
import { NativeBrainManagerError, nativeManagerRequest, NATIVE_CONTROL_BYTES, NATIVE_DATA_CHUNK_BYTES, NATIVE_MANAGER_OPERATION_TIMEOUT_MS, NATIVE_MANAGER_MAX_DELTA_BYTES,
  type NativeCheckpoint, type NativeManagerErrorCode, type NativeManagerReady, type NativeManagerRequest, type NativeRecoveryRecord, type NativeStage, type NativeStageChange } from "./native-brain-manager-protocol.js";

export interface NativeDeltaStream {
  stream: ReadableStream<Uint8Array>;
  /** Must be awaited in addition to the parser's native CRC/END/EOF validation. */
  completed: Promise<{ exitCode: 0; bytes: number }>;
}
export interface NativeStageInspection {
  checkpointId: string;
  checkpointUuid: string;
  changes: AsyncIterable<NativeStageChange>;
  completed: NativeDeltaStream["completed"];
}
export interface NativeCheckpointMetadata {
  path: string; kind: "directory" | "file" | "symlink" | "other";
  mode: number; bytes: number; stamp: string; inode: string; target?: string;
}
export interface NativeCheckpointFile {
  workerUid: number;
  stream: ReadableStream<Uint8Array>;
  completed: Promise<{ bytes: number; workerUid: number }>;
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
  async function checkpointRead(id: string, action: "file" | "stat" | "list", path: string, maximum: number,
    expectedWorkerUid: number, signal?: AbortSignal, operation: "readCheckpoint" | "readStage" = "readCheckpoint"): Promise<NativeCheckpointFile> {
    if (!Number.isSafeInteger(expectedWorkerUid) || expectedWorkerUid <= 0)
      throw new NativeBrainManagerError("unsupported", "Private checkpoint reads require an actual qualified worker identity.");
    const ticket = await control({ operation, id, action, path, maximum }, signal) as NativeCheckpointReadTicket & { token: string };
    const validId = nativeCheckpointId.safeParse(ticket.id).success;
    const cancel = async () => { if (validId) await control({ operation: "cancelCheckpointRead", id: ticket.id }); };
    if (!validId || ticket.socketPath !== nativeCheckpointReaderPath(options.socketPath, ticket.id) || ticket.workerUid !== expectedWorkerUid ||
      typeof ticket.token !== "string" || !nativeCheckpointId.safeParse(ticket.token).success ||
      !Number.isSafeInteger(ticket.maximum) || ticket.maximum < 0 || ticket.maximum > maximum) {
      await cancel();
      throw new NativeBrainManagerError("unsupported", "Native manager fixed reader does not match the host's verified worker identity or authorized channel.");
    }
    const child = consumeNativeCheckpointRead(ticket, signal);
    const timer = setTimeout(() => child.cancel(), options.timeoutMs);
    const completed = child.completed.then(async result => { await cancel(); return result; }, async error => { await cancel(); throw error; })
      .finally(() => clearTimeout(timer));
    void completed.catch(() => {});
    const reader = child.stream.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try { const part = await reader.read(); if (part.done) controller.close(); else controller.enqueue(part.value); }
        catch (error) { child.cancel(); controller.error(error); }
      },
      async cancel(reason) { child.cancel(); await reader.cancel(reason); await completed.catch(() => {}); },
    });
    return { workerUid: ticket.workerUid, stream, completed };
  }
  async function checkpointMetadata(id: string, action: "stat" | "list", path: string, expectedWorkerUid: number, signal?: AbortSignal, operation: "readCheckpoint" | "readStage" = "readCheckpoint"): Promise<unknown> {
    const copy = await checkpointRead(id, action, path, options.maxDeltaBytes, expectedWorkerUid, signal, operation);
    const pieces: Uint8Array[] = []; let length = 0;
    const reader = copy.stream.getReader();
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.byteLength;
        if (length > options.maxDeltaBytes) throw new NativeBrainManagerError("unavailable", "Checkpoint metadata exceeded its transport bound."); pieces.push(part.value); }
      const receipt = await copy.completed;
      if (receipt.bytes !== length) throw new NativeBrainManagerError("unavailable", "Checkpoint metadata completion size differs.");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pieces, length)));
    } finally { await reader.cancel(); await copy.completed.catch(() => {}); }
  }
  function metadata(value: unknown): NativeCheckpointMetadata {
    const item = value as NativeCheckpointMetadata;
    if (!item || typeof item.path !== "string" || !item.path.isWellFormed() || !item.path || item.path.startsWith("/") || item.path.includes("\0") ||
      item.path.split("/").some(part => !part || part === "." || part === "..") ||
      !["file", "directory", "symlink", "other"].includes(item.kind) || !Number.isSafeInteger(item.mode) || item.mode < 0 || item.mode > 0o7777 ||
      !Number.isSafeInteger(item.bytes) || item.bytes < 0 || typeof item.inode !== "string" || !/^\d+$/.test(item.inode) ||
      typeof item.stamp !== "string" || !/^\d+:\d+:\d+:\d+$/.test(item.stamp) ||
      (item.kind === "symlink" && (typeof item.target !== "string" || !item.target.isWellFormed())) ||
      Object.keys(item).sort().join(",") !== (item.kind === "symlink" ? "bytes,inode,kind,mode,path,stamp,target" : "bytes,inode,kind,mode,path,stamp"))
      throw new NativeBrainManagerError("unavailable", "Malformed fixed-reader checkpoint metadata.");
    return item;
  }
  return {
    attestStage: async (id: string, signal?: AbortSignal): Promise<{ fd: number; close(): void }> => {
      const ticket = await control({ operation: "attestStage", id }, signal);
      const validId = nativeCheckpointId.safeParse(ticket.id).success;
      const cancel = async () => { if (validId) await control({ operation: "cancelCheckpointRead", id: ticket.id }); };
      if (!validId || ticket.socketPath !== nativeCheckpointReaderPath(options.socketPath, ticket.id) ||
        !nativeCheckpointId.safeParse(ticket.token).success || Object.keys(ticket).sort().join(",") !== "id,socketPath,token") {
        await cancel(); throw new NativeBrainManagerError("unsupported", "Invalid manager stage authority channel.");
      }
      const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs);
      let authority: { fd: number; close(): void } | undefined;
      try { authority = await consumeNativeStageAuthority(ticket, id, bounded); await cancel(); return authority; }
      catch (error) { authority?.close(); await cancel(); throw error; }
    },
    readStage: (id: string, path: string, maximum: number, expectedWorkerUid: number, signal?: AbortSignal): Promise<NativeCheckpointFile> =>
      checkpointRead(id, "file", path, maximum, expectedWorkerUid, signal, "readStage"),
    statStage: async (id: string, path: string, expectedWorkerUid: number, signal?: AbortSignal): Promise<NativeCheckpointMetadata | null> => {
      const value = await checkpointMetadata(id, "stat", path, expectedWorkerUid, signal, "readStage");
      if (value === null) return null;
      const item = metadata(value);
      if (item.path !== path) throw new NativeBrainManagerError("unavailable", "Stage metadata path differs from its request.");
      return item;
    },
    listStage: async (id: string, path: string, expectedWorkerUid: number, signal?: AbortSignal): Promise<NativeCheckpointMetadata[]> => {
      const value = await checkpointMetadata(id, "list", path, expectedWorkerUid, signal, "readStage");
      if (!Array.isArray(value) || value.length > 200_000) throw new NativeBrainManagerError("unavailable", "Malformed stage directory inventory.");
      const entries = value.map(metadata), names = new Set<string>(), prefix = path ? `${path}/` : "";
      for (const item of entries) {
        const name = item.path.slice(prefix.length);
        if (!item.path.startsWith(prefix) || !name || name.includes("/") || names.has(name)) throw new NativeBrainManagerError("unavailable", "Stage directory inventory differs from its request.");
        names.add(name);
      }
      return entries;
    },
    readCheckpoint: (id: string, path: string, maximum: number, expectedWorkerUid: number, signal?: AbortSignal): Promise<NativeCheckpointFile> =>
      checkpointRead(id, "file", path, maximum, expectedWorkerUid, signal),
    statCheckpoint: async (id: string, path: string, expectedWorkerUid: number, signal?: AbortSignal): Promise<NativeCheckpointMetadata | null> => {
      const value = await checkpointMetadata(id, "stat", path, expectedWorkerUid, signal);
      if (value === null) return null;
      const item = metadata(value);
      if (item.path !== path) throw new NativeBrainManagerError("unavailable", "Checkpoint metadata path differs from its request.");
      return item;
    },
    listCheckpoint: async (id: string, path: string, expectedWorkerUid: number, signal?: AbortSignal): Promise<NativeCheckpointMetadata[]> => {
      const value = await checkpointMetadata(id, "list", path, expectedWorkerUid, signal);
      if (!Array.isArray(value) || value.length > 200_000) throw new NativeBrainManagerError("unavailable", "Malformed checkpoint directory inventory.");
      const entries = value.map(metadata), names = new Set<string>(), prefix = path ? `${path}/` : "";
      for (const item of entries) {
        const name = item.path.slice(prefix.length);
        if (!item.path.startsWith(prefix) || !name || name.includes("/") || names.has(name))
          throw new NativeBrainManagerError("unavailable", "Checkpoint directory inventory escapes or duplicates its requested directory.");
        names.add(name);
      }
      return entries;
    },
    ready: async (signal?: AbortSignal): Promise<NativeManagerReady> => control({ operation: "ready" }, signal),
    checkpoint: async (id: string, signal?: AbortSignal): Promise<NativeCheckpoint> => control({ operation: "checkpoint", id }, signal),
    release: async (id: string, signal?: AbortSignal): Promise<{ id: string; state: "deleted" }> => control({ operation: "release", id }, signal),
    prepareStage: async (id: string, checkpointId: string, allowanceBytes: number, signal?: AbortSignal): Promise<NativeStage> => control({ operation: "prepareStage", id, checkpointId, allowanceBytes }, signal),
    releaseStage: async (id: string, signal?: AbortSignal): Promise<{ id: string; state: "deleted" }> => control({ operation: "releaseStage", id }, signal),
    inspectStage: async (id: string, signal?: AbortSignal): Promise<NativeStageInspection> => {
      const response = await call({ operation: "inspectStage", id }, signal);
      const checkpointId = response.headers.get("x-brain-stage-checkpoint"), checkpointUuid = response.headers.get("x-brain-stage-lower");
      if (response.headers.get("content-type") !== "application/x-brain-native-stage" || response.headers.get("x-brain-stage-id") !== id
        || !checkpointId || !checkpointUuid || !/^[0-9a-f]{32}$/.test(checkpointUuid) || !response.body)
        throw new NativeBrainManagerError("unavailable", "Native manager returned no complete stage inspection.");
      const framed = decodeNativeDelta(response.body, options.maxDeltaBytes);
      return { checkpointId, checkpointUuid, completed: framed.completed,
        changes: (async function* () {
          const reader = framed.stream.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
          let pending = "", count = 0;
          try { for (;;) {
            const item = await reader.read(); if (item.done) break;
            pending += decoder.decode(item.value, { stream: true });
            for (;;) {
              const end = pending.indexOf("\n"); if (end < 0) break;
              const line = pending.slice(0, end); pending = pending.slice(end + 1);
              if (Buffer.byteLength(line) > NATIVE_CONTROL_BYTES || ++count > 200_000)
                throw new NativeBrainManagerError("capacity", "Stage metadata exceeded its existing entry/control bounds.");
              const row = JSON.parse(line) as NativeStageChange;
              if (Object.keys(row).sort().join(",") !== "kind,pathHex" || !["entry", "whiteout", "opaque"].includes(row.kind)
                || typeof row.pathHex !== "string" || !/^(?:[0-9a-f]{2})+$/.test(row.pathHex))
                throw new NativeBrainManagerError("unavailable", "Malformed stage change metadata.");
              yield row;
              if (count % 256 === 0) await Bun.sleep(0);
            }
            if (Buffer.byteLength(pending) > NATIVE_CONTROL_BYTES) throw new NativeBrainManagerError("capacity", "Stage metadata row exceeded its control bound.");
          }
          pending += decoder.decode(); if (pending) throw new NativeBrainManagerError("unavailable", "Stage metadata ended within a row.");
          await framed.completed;
          } finally { await reader.cancel(); }
        })(),
      };
    },
    listRecovery: async (after: string | null = null, signal?: AbortSignal): Promise<{ records: NativeRecoveryRecord[]; next: string | null }> => control({ operation: "listRecovery", after }, signal),
    delta: async (from: string, to: string, signal?: AbortSignal): Promise<NativeDeltaStream> => {
      const response = await call({ operation: "delta", from, to }, signal);
      if (response.headers.get("content-type") !== "application/x-brain-native-delta" || !response.body)
        throw new NativeBrainManagerError("unavailable", "Native manager returned no framed delta.");
      return decodeNativeDelta(response.body, options.maxDeltaBytes);
    },
  };
}
