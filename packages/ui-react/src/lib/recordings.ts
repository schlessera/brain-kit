import type { BrainUiServices } from "../root.js";
import { startLocalCapture, type LocalCapture, type LocalCaptureChunk, type LocalCaptureSink, type LocalCaptureStopReason, type StartLocalCaptureOptions } from "../voice/local-capture.js";
import { accountPartition, PartitionRefusedError, type LocalPartitions, type PartitionId, type PartitionWrite } from "./local-partitions.js";
import { registerUpdateHold } from "./update-holds.js";

/** Limits from #578's retention ruling; the budget and warning are tuning defaults. */
export const RECORDING_MAX_MS = 600_000;
export const RECORDING_MAX_BYTES = 100 * 1024 * 1024;
const MIN_BYTES = 30 * 16_000; // 30 seconds at a conservative 128 kbit/s.
const SAFETY_BYTES = 1024 * 1024;
const INDEX = "recording:index:";
const CHUNKS = "recording:chunk:";
const REMOVED = "recording:removed";
const LOCK = "brain-ui:recording";
// Same-page roots invalidate synchronously; other tabs receive the same identity.
const invalidators = new Set<(id: string) => void>();

export type RecordingState = "recording" | "saved" | "interrupted" | "transcribing" | "transcript-ready" | "failed" | "accepted";
export interface Recording {
  id: string;
  partition: PartitionId;
  state: RecordingState;
  mime: string;
  durationMs: number;
  bytes: number;
  savedThroughMs: number;
  interruptedAt?: number;
  contentHash: string;
  transcript?: string;
  acceptedDraftRev?: number;
  transcribeRequestId?: string;
  /** Number of committed chunks. Internal recovery checks this against the audio. */
  chunkCount: number;
}
export interface RecordingBudget { bytes: number; canRecord: boolean; message: string | null }
export interface RecordingEvent {
  kind: "warning" | "stopped" | "refused" | "committed";
  message: string | null;
  savedThroughMs: number;
}
export interface RecordingRecovery {
  recordings: Recording[];
  removedCount: number;
  removedMessage: string | null;
}
export interface RecordingStore {
  budget(): Promise<RecordingBudget>;
  /** Preflight happens before the microphone opens. Never invoked by recovery. */
  start(options?: Omit<StartLocalCaptureOptions, "sink">): Promise<LocalCapture>;
  /** Deferred sink for a caller that owns capture; nothing persists until begin. Prefer start for preflight before permission. */
  sink(): LocalCaptureSink;
  stop(reason: LocalCaptureStopReason): Promise<void>;
  list(partition: PartitionId): Promise<Recording[]>;
  get(partition: PartitionId, id: string): Promise<Recording | undefined>;
  recover(partition: PartitionId): Promise<RecordingRecovery>;
  dismissRemoved(partition: PartitionId): Promise<void>;
  playback(partition: PartitionId, id: string): Promise<{ url: string; revoke(): void }>;
  discard(partition: PartitionId, id: string): Promise<void>;
  /** Only unassigned audio may move, and only into the account held now. */
  assign(id: string): Promise<void>;
  busy(): boolean;
  subscribe(listener: () => void): () => void;
  onEvent(listener: (event: RecordingEvent) => void): () => void;
  dispose(): void;
}
export interface RecordingStoreOptions {
  partitions: LocalPartitions;
  heldAccountKey: () => string | null;
  root: BrainUiServices;
}

type Index = Omit<Recording, "partition">;
const indexKey = (id: string) => `${INDEX}${id}`;
const chunkPrefix = (id: string) => `${CHUNKS}${id}:`;
const chunkKey = (id: string, n: number) => `${chunkPrefix(id)}${n.toString().padStart(8, "0")}`;
export function recordingTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
}
const notEnough = "Not enough space on this device to record. Free space by transcribing or discarding recordings.";
async function hash(blobs: Blob[]): Promise<string> {
  const bytes = await new Blob(blobs).arrayBuffer();
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}
function contiguousChunks(all: LocalCaptureChunk[]): LocalCaptureChunk[] {
  const kept: LocalCaptureChunk[] = [];
  for (const chunk of all) {
    if (chunk.index !== kept.length || chunk.startMs !== (kept.at(-1)?.endMs ?? 0)) break;
    kept.push(chunk);
  }
  return kept;
}
async function recoveredIndex(index: Index, kept: LocalCaptureChunk[], total: number): Promise<Index> {
  if (index.state !== "recording" && kept.length === index.chunkCount && kept.length === total) return index;
  const end = kept.at(-1)!.endMs;
  return { ...index, state: "interrupted", interruptedAt: end, durationMs: end, savedThroughMs: end, bytes: kept.reduce((n, c) => n + c.data.size, 0), chunkCount: kept.length, contentHash: await hash(kept.map((c) => c.data)) };
}

/** Account gating is delegated to #1014's primitive on every read and write. No age expiry or eviction. */
export function createRecordingStore(options: RecordingStoreOptions): RecordingStore {
  const { partitions } = options;
  const listeners = new Set<() => void>();
  const events = new Set<(event: RecordingEvent) => void>();
  let running: Session | null = null;
  let opening = false;
  let disposed = false;
  let openingAbort: AbortController | null = null;
  let openingCapture: LocalCapture | null = null;
  let beginning: { cancelled: boolean; stop?: LocalCapture["stop"]; done: Promise<void> } | null = null;
  const urls = new Map<string, { partition: PartitionId; id: string }>();
  const pendingPlaybacks = new Set<{ partition: PartitionId; id: string; cancelled: boolean }>();
  const repaired = new Map<string, { source: string; value: Index | null }>();
  const identity = (partition: PartitionId, id: string) => `${partition}/${id}`;
  const fingerprint = (row: Index) => `${row.state}/${row.chunkCount}/${row.bytes}/${row.savedThroughMs}/${row.contentHash}`;
  function present(partition: PartitionId, row: Index): Index | null {
    const repair = repaired.get(identity(partition, row.id));
    return repair?.source === fingerprint(row) ? repair.value : row;
  }
  const revoke = (url: string) => { URL.revokeObjectURL(url); urls.delete(url); };
  const unwatchAccount = options.root.stores.connection.subscribe(() => {
    for (const [url, { partition }] of urls) if (partition !== "unassigned" && partition !== heldPartition()) revoke(url);
    for (const playback of pendingPlaybacks) if (playback.partition !== "unassigned" && playback.partition !== heldPartition()) playback.cancelled = true;
    for (const key of repaired.keys()) if (!key.startsWith("unassigned/") && !key.startsWith(`${heldPartition()}/`)) repaired.delete(key);
  });
  const notify = () => { for (const fn of listeners) fn(); };
  const emit = (kind: RecordingEvent["kind"], message: string | null, savedThroughMs = 0) => {
    for (const fn of events) fn({ kind, message, savedThroughMs });
  };
  const invalidate = (id: string) => {
    for (const playback of pendingPlaybacks) if (playback.id === id) playback.cancelled = true;
    for (const [url, recording] of urls) if (recording.id === id) revoke(url);
  };
  invalidators.add(invalidate);
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("brain-ui:recording-changes");
  if (channel) channel.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") invalidate(event.data);
  };
  const changed = (id: string) => { for (const fn of invalidators) fn(id); if (!disposed) channel?.postMessage(id); };
  const heldPartition = () => {
    const key = options.heldAccountKey();
    return key === null ? "unassigned" as const : accountPartition(key);
  };
  function checkReadable(partition: PartitionId): void {
    if (partition !== "unassigned" && partition !== heldPartition()) throw new PartitionRefusedError(partition);
  }
  async function budget(): Promise<RecordingBudget> {
    const sizes = await partitions.sizes(CHUNKS);
    let bytes = RECORDING_MAX_BYTES - sizes.reduce((sum, row) => sum + row.bytes, 0);
    // The estimate may not reflect a full physical disk. Writes are authoritative.
    try {
      const estimate = await navigator.storage?.estimate?.();
      if (estimate?.quota !== undefined && estimate.usage !== undefined) bytes = Math.min(bytes, estimate.quota - estimate.usage - SAFETY_BYTES);
    } catch { /* An unavailable estimate does not invent capacity; writes still stop on error. */ }
    bytes = Math.max(0, bytes);
    return { bytes, canRecord: bytes >= MIN_BYTES, message: bytes >= MIN_BYTES ? null : notEnough };
  }
  async function acquire(): Promise<() => Promise<void>> {
    if (!navigator.locks) throw new DOMException("This browser cannot coordinate recording tabs.", "NotSupportedError");
    return new Promise((resolve, reject) => {
      const requested = navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock) { reject(new Error("Recording in another Brain tab")); return; }
        await new Promise<void>((unlock) => resolve(async () => { unlock(); await requested; }));
      });
      void requested.catch(reject);
    });
  }
  interface Session {
    row: Index;
    partition: PartitionId;
    blobs: Blob[];
    release: () => Promise<void>;
    timers: ReturnType<typeof setTimeout>[];
    capture: Pick<LocalCapture, "stop"> | null;
    accepting: boolean;
    authInterrupted: boolean;
    write: Promise<void> | null;
    failure: "budget" | "write" | null;
    ending: Promise<void> | null;
  }
  function deferred(preflight?: { partition: PartitionId; release: () => Promise<void>; signal: AbortSignal }): LocalCaptureSink {
    let session: Session | null = null;
    return {
      async begin({ mimeType, stop }) {
        if (disposed || running || beginning) throw new Error("Recording is already running or the store is closed");
        const partition = preflight?.partition ?? heldPartition();
        let completed!: () => void;
        const pending = { cancelled: false, stop, done: new Promise<void>((resolve) => { completed = resolve; }) };
        beginning = pending;
        notify();
        // Capture is already live. Storage initialization must not delay the
        // deadline; stop the microphone while the queued prefix still drains.
        const timers = [
          setTimeout(() => emit("warning", "1 minute left in this recording", session?.row.savedThroughMs ?? 0), 540_000),
          setTimeout(() => { void (stop ? stop("limit") : store.stop("limit")); }, RECORDING_MAX_MS),
        ];
        let release: (() => Promise<void>) | undefined;
        const checkStart = () => {
          preflight?.signal.throwIfAborted();
          if (disposed || pending.cancelled) throw new DOMException("Recording start was cancelled", "AbortError");
        };
        try {
          release = preflight?.release ?? await acquire();
          checkStart();
          const free = await budget();
          checkStart();
          if (!free.canRecord) { emit("refused", notEnough); throw new Error(notEnough); }
          const row: Index = { id: crypto.randomUUID(), state: "recording", mime: mimeType, durationMs: 0, bytes: 0, savedThroughMs: 0, contentHash: "", chunkCount: 0 };
          // The first durable index exists only once capture has really begun.
          const handle = partitions.open(partition);
          await handle.put(indexKey(row.id), row);
          try { checkStart(); } catch (error) {
            // The initial transaction may finish after cancellation. No audio
            // has reached the sink, so remove its empty index when accessible.
            await handle.write([{ delete: indexKey(row.id) }]).catch(() => {});
            throw error;
          }
          session = { row, partition, blobs: [], release, timers, capture: stop ? { stop } : null, accepting: !preflight?.signal.aborted, authInterrupted: false, write: null, failure: null, ending: null };
          running = session;
          notify();
        } catch (error) { for (const timer of timers) clearTimeout(timer); await release?.(); throw error; }
        finally { if (beginning === pending) beginning = null; completed(); notify(); }
      },
      async chunk(chunk) {
        const s = session;
        if (!s || !s.accepting) return;
        if (chunk.index !== s.row.chunkCount || chunk.startMs !== s.row.savedThroughMs) {
          s.failure = "write"; s.accepting = false;
          throw new Error("Audio chunks must be contiguous and ordered");
        }
        // Do not truncate an encoded chunk: retain a playable contiguous prefix.
        if (chunk.endMs > RECORDING_MAX_MS) { s.accepting = false; void s.capture?.stop("limit"); return; }
        const free = await budget();
        if (!s.accepting) return;
        if (chunk.data.size > free.bytes) {
          s.failure = "budget"; s.accepting = false;
          void s.capture?.stop("storage");
          throw new Error("Recording storage is full");
        }
        const next = { ...s.row, bytes: s.row.bytes + chunk.data.size, durationMs: chunk.endMs, savedThroughMs: chunk.endMs, chunkCount: s.row.chunkCount + 1 };
        const write = partitions.open(s.partition).write([
          { put: chunkKey(s.row.id, chunk.index), value: chunk },
          { put: indexKey(s.row.id), value: next },
        ]);
        s.write = write;
        try {
          await write;
          s.row = next;
          s.blobs.push(chunk.data);
          emit("committed", null, next.savedThroughMs);
        } catch (error) {
          // Includes QuotaExceededError and Chromium's DataError / blob IOError.
          s.failure = "write"; s.accepting = false;
          throw error;
        } finally { s.write = null; }
      },
      async end(reason) {
        const s = session;
        if (!s) return;
        s.ending ??= finish(s, reason);
        await s.ending;
      },
    };
  }
  async function finish(s: Session, reason: LocalCaptureStopReason): Promise<void> {
    s.accepting = false;
    for (const timer of s.timers) clearTimeout(timer);
    try {
      const contentHash = await hash(s.blobs);
      const interrupted = reason === "auth" || reason === "interrupted" || s.authInterrupted || s.failure === "write";
      let row: Index = { ...s.row, state: interrupted ? "interrupted" : "saved", contentHash, ...(interrupted ? { interruptedAt: s.row.savedThroughMs } : {}) };
      const applyAuth = () => {
        if (s.authInterrupted && row.state !== "interrupted") row = { ...row, state: "interrupted", interruptedAt: row.savedThroughMs };
      };
      let durable = s.row;
      try {
        await partitions.open(s.partition).put(indexKey(row.id), row);
        durable = row;
        if (s.authInterrupted && row.state !== "interrupted") {
          // Auth can arrive while a user stop's final metadata is committing.
          // The capture keeps its first stop reason; the stored outcome does not.
          applyAuth();
          await partitions.open(s.partition).put(indexKey(row.id), row);
        }
      } catch {
        applyAuth();
        if (s.partition === "unassigned" || s.partition === heldPartition()) repaired.set(identity(s.partition, row.id), { source: fingerprint(durable), value: row });
        // Full disk or auth already cleared: the committed index and chunks
        // survive. Recovery classifies its recording state as interrupted.
      }
      const time = recordingTime(row.savedThroughMs);
      const message = s.failure === "write" ? `Stopped: this device couldn't save more audio. Saved up to ${time}; the end may be missing.`
        : s.failure === "budget" ? `Stopped: storage for recordings is full. Saved up to ${time}.`
        : reason === "limit" && row.state !== "interrupted" ? "Stopped at the 10-minute limit. Your recording is saved."
        : row.state === "interrupted" ? `Recording stopped. Saved up to ${time}; the end may be missing.` : "Recording saved on this device.";
      emit("stopped", message, row.savedThroughMs);
    } finally {
      s.blobs = [];
      await s.release();
      if (running === s) running = null;
      notify();
    }
  }
  async function get(partition: PartitionId, id: string): Promise<Recording | undefined> {
    const value = await partitions.open(partition).get(indexKey(id)) as Index | undefined;
    checkReadable(partition);
    const shown = value ? present(partition, value) : null;
    return shown ? { ...shown, partition } : undefined;
  }
  async function chunks(partition: PartitionId, id: string): Promise<LocalCaptureChunk[]> {
    return (await partitions.open(partition).list(chunkPrefix(id))).map((r) => r.value as LocalCaptureChunk).sort((a, b) => a.index - b.index);
  }
  const store: RecordingStore = {
    budget,
    sink: () => deferred(),
    async start(env = {}) {
      if (disposed || opening || running) throw new Error("Recording is already running or the store is closed");
      opening = true; notify();
      const controller = new AbortController();
      openingAbort = controller;
      const signal = env.signal ? AbortSignal.any([env.signal, controller.signal]) : controller.signal;
      let release: (() => Promise<void>) | undefined;
      try {
        const partition = heldPartition();
        release = await acquire();
        const free = await budget();
        if (!free.canRecord) { emit("refused", notEnough); throw new Error(notEnough); }
        signal.throwIfAborted();
        const sink = deferred({ partition, release, signal });
        let ready!: () => void;
        let failed!: (error: unknown) => void;
        const begun = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
        const capture = await startLocalCapture({ ...env, signal, sink: {
          ...sink,
          async begin(info) {
            try { await sink.begin?.(info); ready(); } catch (error) { failed(error); throw error; }
          },
        } });
        openingCapture = capture;
        try { await begun; } catch (error) { await capture.ended; throw error; }
        if (running) (running as Session).capture = capture;
        if (controller.signal.aborted || disposed) await capture.stop("interrupted");
        return capture;
      } catch (error) { await release?.(); throw error; }
      finally { opening = false; openingAbort = null; openingCapture = null; notify(); }
    },
    async stop(reason) {
      openingAbort?.abort();
      if (reason === "auth") {
        for (const playback of pendingPlaybacks) if (playback.partition !== "unassigned") playback.cancelled = true;
        for (const [url, { partition }] of urls) if (partition !== "unassigned") revoke(url);
      }
      const s = running;
      if (!s) {
        const pending = beginning;
        if (pending) {
          pending.cancelled = true;
          await pending.stop?.(reason);
          await pending.done;
        } else await openingCapture?.stop(reason);
        return;
      }
      if (reason === "auth") {
        s.authInterrupted = true;
        s.accepting = false; // queued/final chunks cannot start writes.
      }
      if (s.capture || openingCapture) await (s.capture ?? openingCapture)!.stop(reason);
      else { await s.write?.catch(() => {}); s.ending ??= finish(s, reason); await s.ending; }
    },
    get,
    async list(partition) {
      const entries = await partitions.open(partition).list(INDEX);
      checkReadable(partition);
      return entries.flatMap((r) => {
        const shown = present(partition, r.value as Index);
        return shown ? [{ ...shown, partition }] : [];
      });
    },
    async recover(partition) {
      // Never recover under a live recorder, including a recorder in another tab.
      const release = await acquire();
      let result!: RecordingRecovery;
      try {
        const handle = partitions.open(partition);
        let removedCount = (await handle.get(REMOVED) as number | undefined) ?? 0;
        const recovered: Recording[] = [];
        const removed: Array<{ index: Index; audio: LocalCaptureChunk[] }> = [];
        // Durable headers remain loss witnesses; a matching repair also carries
        // known auth corrections that a full device could not yet commit.
        for (const entry of await handle.list(INDEX)) {
          const index = entry.value as Index;
          const all = await chunks(partition, index.id);
          const kept = contiguousChunks(all);
          if (!kept.length) {
            removedCount++;
            removed.push({ index, audio: all });
            repaired.set(identity(partition, index.id), { source: fingerprint(index), value: null });
          } else {
            const shown = await recoveredIndex(present(partition, index) ?? index, kept, all.length);
            if (shown !== index) {
              try {
                await handle.write([{ put: indexKey(index.id), value: shown }, ...all.slice(kept.length).map((c) => ({ delete: chunkKey(index.id, c.index) }))]);
              } catch {
                // A full device can still read and play its committed prefix.
                repaired.set(identity(partition, index.id), { source: fingerprint(index), value: shown });
              }
            }
            recovered.push({ ...shown, partition });
          }
        }
        if (removed.length) {
          // Count and delete all loss witnesses in one transaction. A failed
          // repair leaves all of them to retry, without persisting a count that
          // already includes a witness still present on the next launch.
          try {
            await handle.write([
              ...removed.flatMap(({ index, audio }) => [{ delete: indexKey(index.id) }, ...audio.map((c) => ({ delete: chunkKey(index.id, c.index) }))]),
              { put: REMOVED, value: removedCount },
            ]);
            for (const { index } of removed) repaired.delete(identity(partition, index.id));
          } catch { /* The durable indexes remain witnesses, including on a full device. */ }
        }
        // A failed repair must never turn auth loss into a readable result.
        await handle.get(REMOVED);
        result = { recordings: recovered, removedCount, removedMessage: removedCount ? `${removedCount} recordings were removed by the browser before they were transcribed.` : null };
      } finally { await release(); }
      checkReadable(partition);
      return result;
    },
    async dismissRemoved(partition) {
      const release = await acquire();
      try {
        const handle = partitions.open(partition);
        const changes: PartitionWrite[] = [{ delete: REMOVED }];
        const removed: string[] = [];
        for (const entry of await handle.list(INDEX)) {
          const row = entry.value as Index;
          const audio = await chunks(partition, row.id);
          if (!contiguousChunks(audio).length) {
            changes.push({ delete: indexKey(row.id) }, ...audio.map((c) => ({ delete: chunkKey(row.id, c.index) })));
            removed.push(row.id);
          }
        }
        await handle.write(changes);
        for (const id of removed) repaired.delete(identity(partition, id));
      } finally { await release(); }
    },
    async playback(partition, id) {
      const pending = { partition, id, cancelled: false };
      pendingPlaybacks.add(pending);
      try {
        const row = await get(partition, id);
        if (!row) throw new Error("Recording not found");
        const audio = (await chunks(partition, id)).slice(0, row.chunkCount);
        if (!await partitions.open(partition).get(indexKey(id))) throw new Error("Recording is no longer available");
        // The primitive's async return is itself a handoff: recheck authority
        // synchronously here, without another await before creating the URL.
        checkReadable(partition);
        if (disposed) throw new Error("Recording store is closed");
        if (pending.cancelled) throw new Error("Recording is no longer available");
        const url = URL.createObjectURL(new Blob(audio.map((c) => c.data), { type: row.mime }));
        urls.set(url, { partition, id });
        return { url, revoke: () => revoke(url) };
      } finally { pendingPlaybacks.delete(pending); }
    },
    async discard(partition, id) {
      const release = await acquire();
      try {
        const audio = await chunks(partition, id);
        await partitions.open(partition).write([{ delete: indexKey(id) }, ...audio.map((c) => ({ delete: chunkKey(id, c.index) }))]);
        repaired.delete(identity(partition, id));
        changed(id);
      } finally { await release(); }
    },
    async assign(id) {
      const to = heldPartition();
      if (to === "unassigned") throw new Error("Sign in before associating a recording");
      const release = await acquire();
      try {
        const row = await get("unassigned", id);
        if (!row) throw new Error("Unassigned recording not found");
        const audio = await chunks("unassigned", id);
        const kept = contiguousChunks(audio);
        if (!kept.length) throw new Error("Unassigned recording has no playable audio");
        const { partition: _partition, ...index } = row;
        const shown = await recoveredIndex(index, kept, audio.length);
        // Commit the recovered view before moving its durable records. When
        // storage is still full, association fails and leaves the source kept.
        await partitions.open("unassigned").write([{ put: indexKey(id), value: shown }, ...audio.slice(kept.length).map((c) => ({ delete: chunkKey(id, c.index) }))]);
        await partitions.move("unassigned", to, [indexKey(id), ...kept.map((c) => chunkKey(id, c.index))]);
        repaired.delete(identity("unassigned", id));
        changed(id);
      } finally { await release(); }
    },
    busy: () => opening || beginning !== null || running !== null,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onEvent(fn) { events.add(fn); return () => { events.delete(fn); }; },
    dispose() { disposed = true; unwatchAccount(); invalidators.delete(invalidate); channel?.close(); repaired.clear(); for (const url of urls.keys()) revoke(url); void store.stop("interrupted").finally(releaseHold); },
  };
  const releaseHold = registerUpdateHold(options.root, store);
  return store;
}
