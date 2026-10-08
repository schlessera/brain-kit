import type { RecordingTranscription } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";
import { startLocalCapture, type LocalCapture, type LocalCaptureChunk, type LocalCaptureSink, type LocalCaptureStopReason, type StartLocalCaptureOptions } from "../voice/local-capture.js";
import { accountPartition, PartitionRefusedError, type LocalPartitions, type PartitionId, type PartitionWrite, type WriterFence } from "./local-partitions.js";
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
type RecordingChange = string | { partition: PartitionId; closed?: WriterFence };
const invalidators = new Set<(change: RecordingChange) => void>();

export type RecordingState = "recording" | "saved" | "interrupted" | "transcribing" | "transcript-ready" | "failed" | "accepted";
export interface Recording {
  id: string;
  partition: PartitionId;
  state: RecordingState;
  /** Device clock at capture start. Older indexes may not have a timestamp. */
  createdAt?: number;
  mime: string;
  durationMs: number;
  bytes: number;
  savedThroughMs: number;
  interruptedAt?: number;
  contentHash: string;
  transcript?: string;
  acceptedDraftRev?: number;
  transcribeRequestId?: string;
  transcription?: RecordingTranscription;
  transcriptionMessage?: string;
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
  /** Identity of this store's live capture; callers may retain it through termination. */
  active(): Pick<Recording, "partition" | "id"> | null;
  list(partition: PartitionId): Promise<Recording[]>;
  get(partition: PartitionId, id: string): Promise<Recording | undefined>;
  recover(partition: PartitionId): Promise<RecordingRecovery>;
  dismissRemoved(partition: PartitionId): Promise<void>;
  playback(partition: PartitionId, id: string): Promise<{ url: string; revoke(): void }>;
  discard(partition: PartitionId, id: string): Promise<void>;
  /** Persist editable review text before reporting it ready. */
  saveTranscript(partition: PartitionId, id: string, text: string): Promise<void>;
  /** Commit before marking accepted/deleting audio; retained receipts prevent duplicate appends. Missing recordings are refused. */
  accept(partition: PartitionId, id: string, draftId: string, sessionId: string | null, expectedTranscript?: string): Promise<void>;
  /** Only unassigned audio may move, and only into the account held now. */
  assign(id: string): Promise<void>;
  /** @internal Stop this root and clear only the authorized sign-out partitions. */
  clearForSignOut(partition: PartitionId, alsoUnassigned: boolean, clearAccount?: () => Promise<void>): Promise<void>;
  /** Explicitly confirmed upload, coordinated across tabs by recording id. */
  transcribe(partition: PartitionId, id: string, progress: (percent: number) => void, retry?: string): Promise<void>;
  /** Read-only recovery plus tombstones previously requested by accept/discard. Never uploads audio. */
  syncTranscriptions(): Promise<void>;
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
export const RECORDING_UNAVAILABLE = "This recording is no longer available on this device.";
export const TRANSCRIPT_CHANGED = "Transcript changed in another tab. Review it before adding it to your draft.";
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
  return { ...index, state: typeof index.transcript === "string" ? index.state === "accepted" ? "accepted" : "transcript-ready" : "interrupted", interruptedAt: end, durationMs: end, savedThroughMs: end, bytes: kept.reduce((n, c) => n + c.data.size, 0), chunkCount: kept.length, contentHash: await hash(kept.map((c) => c.data)) };
}

/** Account gating is delegated to #1014's primitive on every read and write. No age expiry or eviction. */
export function createRecordingStore(options: RecordingStoreOptions): RecordingStore {
  const { partitions } = options;
  const transcripts = new Set<string>();
  let inventoryVersion = 0;
  const listeners = new Set<() => void>();
  const events = new Set<(event: RecordingEvent) => void>();
  let running: Session | null = null;
  let opening = false;
  let openingGeneration: string | null = null;
  let disposed = false;
  let signingOut = false;
  let openingAbort: AbortController | null = null;
  let openingCapture: LocalCapture | null = null;
  let beginning: { partition: PartitionId; generation: string; cancelled: boolean; stop?: LocalCapture["stop"]; done: Promise<void> } | null = null;
  const urls = new Map<string, { partition: PartitionId; id: string; generation: string }>();
  const pendingPlaybacks = new Set<{ partition: PartitionId; id: string; generation: string; cancelled: boolean }>();
  const closedFences = new Map<PartitionId, WriterFence>();
  const closedGeneration = (closed: WriterFence, generation: string) => !!closed.predecessors?.includes(generation);
  const sameGeneration = (partition: PartitionId, generation: string) => { try { return partitions.writerGeneration(partition) === generation; } catch { return false; } };
  const mutationEpochs = new Map<PartitionId, number>();
  const mutationEpoch = (partition: PartitionId) => ({ notification: mutationEpochs.get(partition) ?? 0, generation: partitions.writerGeneration(partition) });
  const checkMutation = (partition: PartitionId, epoch: ReturnType<typeof mutationEpoch>) => {
    checkReadable(partition);
    if ((mutationEpochs.get(partition) ?? 0) !== epoch.notification || partitions.writerGeneration(partition) !== epoch.generation) throw new PartitionRefusedError(partition);
  };
  const repaired = new Map<string, { source: string; value: Index | null }>();
  const identity = (partition: PartitionId, id: string) => `${partition}/${id}`;
  const fingerprint = (row: Index) => JSON.stringify([row.state, row.chunkCount, row.bytes, row.savedThroughMs, row.contentHash, row.transcript, row.acceptedDraftRev]);
  function present(partition: PartitionId, row: Index): Index | null {
    const repair = repaired.get(identity(partition, row.id));
    return repair?.source === fingerprint(row) ? repair.value : row;
  }
  const revoke = (url: string) => { URL.revokeObjectURL(url); urls.delete(url); };
  const unwatchAccount = options.root.stores.connection.subscribe(() => {
    for (const key of transcripts) if (!key.startsWith("unassigned/") && !key.startsWith(`${heldPartition()}/`)) transcripts.delete(key);
    for (const [url, { partition }] of urls) if (partition !== "unassigned" && partition !== heldPartition()) revoke(url);
    for (const playback of pendingPlaybacks) if (playback.partition !== "unassigned" && playback.partition !== heldPartition()) playback.cancelled = true;
    for (const key of repaired.keys()) if (!key.startsWith("unassigned/") && !key.startsWith(`${heldPartition()}/`)) repaired.delete(key);
  });
  const notify = () => { for (const fn of listeners) fn(); };
  const emit = (kind: RecordingEvent["kind"], message: string | null, savedThroughMs = 0) => {
    for (const fn of events) fn({ kind, message, savedThroughMs });
  };
  const invalidate = (change: RecordingChange) => {
    inventoryVersion++;
    const affected = (recording: { partition: PartitionId; id: string; generation: string }) => typeof change === "string" ? recording.id === change : recording.partition === change.partition && (!change.closed || closedGeneration(change.closed, recording.generation) || recording.generation === change.closed.token);
    if (typeof change !== "string" && (!change.closed || sameGeneration(change.partition, change.closed.token))) {
      for (const key of repaired.keys()) if (key.startsWith(`${change.partition}/`)) repaired.delete(key);
      for (const key of transcripts) if (key.startsWith(`${change.partition}/`)) transcripts.delete(key);
    }
    scan();
    notify();
    for (const playback of pendingPlaybacks) if (affected(playback)) playback.cancelled = true;
    for (const [url, recording] of urls) if (affected(recording)) revoke(url);
  };
  invalidators.add(invalidate);
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("brain-ui:recording-changes");
  if (channel) channel.onmessage = (event: MessageEvent<unknown>) => {
    if (typeof event.data === "string") invalidate(event.data);
    else if (event.data && typeof event.data === "object" && "partition" in event.data && typeof event.data.partition === "string" && (event.data.partition === "unassigned" || event.data.partition.startsWith("account:"))) invalidate(event.data as Exclude<RecordingChange, string>);
  };
  const changed = (change: RecordingChange) => { for (const fn of invalidators) fn(change); if (!disposed) channel?.postMessage(change); };
  const heldPartition = () => {
    const key = options.heldAccountKey();
    return key === null ? "unassigned" as const : accountPartition(key);
  };
  function checkReadable(partition: PartitionId): void {
    if (signingOut) throw new Error("Signing out");
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
    generation: string;
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
  function deferred(preflight?: { partition: PartitionId; generation: string; release: () => Promise<void>; signal: AbortSignal }): LocalCaptureSink {
    let session: Session | null = null;
    return {
      async begin({ mimeType, stop }) {
        if (signingOut) throw new Error("Signing out");
        if (disposed || running || beginning) throw new Error("Recording is already running or the store is closed");
        const partition = preflight?.partition ?? heldPartition();
        let completed!: () => void;
        const pending = { partition, generation: preflight?.generation ?? partitions.writerGeneration(partition), cancelled: false, stop, done: new Promise<void>((resolve) => { completed = resolve; }) };
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
          if (!sameGeneration(partition, pending.generation)) throw new PartitionRefusedError(partition);
        };
        try {
          release = preflight?.release ?? await acquire();
          checkStart();
          const free = await budget();
          checkStart();
          if (!free.canRecord) { emit("refused", notEnough); throw new Error(notEnough); }
          const row: Index = { id: crypto.randomUUID(), state: "recording", createdAt: Date.now(), mime: mimeType, durationMs: 0, bytes: 0, savedThroughMs: 0, contentHash: "", chunkCount: 0 };
          // The first durable index exists only once capture has really begun.
          if (partition === "unassigned") pending.generation = await partitions.allowUnassignedAction();
          if (opening && heldPartition() === partition) openingGeneration = pending.generation;
          checkStart();
          const handle = partitions.open(partition);
          await handle.put(indexKey(row.id), row);
          try { checkStart(); } catch (error) {
            // The initial transaction may finish after cancellation. No audio
            // has reached the sink, so remove its empty index when accessible.
            await handle.write([{ delete: indexKey(row.id) }]).catch(() => {});
            throw error;
          }
          session = { row, partition, generation: pending.generation, blobs: [], release, timers, capture: stop ? { stop } : null, accepting: !preflight?.signal.aborted, authInterrupted: false, write: null, failure: null, ending: null };
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
        if (!sameGeneration(s.partition, s.generation)) { s.authInterrupted = true; s.accepting = false; throw new PartitionRefusedError(s.partition); }
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
          notify();
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
        if (!sameGeneration(s.partition, s.generation)) throw new PartitionRefusedError(s.partition);
        await partitions.open(s.partition).put(indexKey(row.id), row);
        if (!sameGeneration(s.partition, s.generation)) throw new PartitionRefusedError(s.partition);
        durable = row;
        if (s.authInterrupted && row.state !== "interrupted") {
          // Auth can arrive while a user stop's final metadata is committing.
          // The capture keeps its first stop reason; the stored outcome does not.
          applyAuth();
          await partitions.open(s.partition).put(indexKey(row.id), row);
        }
      } catch {
        applyAuth();
        if (sameGeneration(s.partition, s.generation) && (s.partition === "unassigned" || s.partition === heldPartition())) repaired.set(identity(s.partition, row.id), { source: fingerprint(durable), value: row });
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
  async function acceptedView(partition: PartitionId, index: Index): Promise<Recording> {
    const receipt = await partitions.open(partition).get(`recording:accepted:${index.id}`) as { revision: number } | undefined;
    checkReadable(partition);
    // A committed draft is already accepted even if its following metadata
    // write failed. Review text is then read-only until cleanup can retry.
    return receipt ? { ...index, partition, state: "accepted", acceptedDraftRev: receipt.revision }
      : { ...index, partition };
  }
  async function get(partition: PartitionId, id: string): Promise<Recording | undefined> {
    const value = await partitions.open(partition).get(indexKey(id)) as Index | undefined;
    checkReadable(partition);
    const shown = value ? present(partition, value) : null;
    return shown ? acceptedView(partition, shown) : undefined;
  }
  async function chunks(partition: PartitionId, id: string): Promise<LocalCaptureChunk[]> {
    return (await partitions.open(partition).list(chunkPrefix(id))).map((r) => r.value as LocalCaptureChunk).sort((a, b) => a.index - b.index);
  }
  function trackTranscripts(partition: PartitionId, rows: Recording[]) {
    const before = transcripts.size;
    for (const key of transcripts) if (key.startsWith(`${partition}/`)) transcripts.delete(key);
    for (const row of rows) if (row.state === "transcript-ready" || row.state === "accepted" || row.state === "transcribing") transcripts.add(identity(partition, row.id));
    if (before !== transcripts.size) notify();
  }
  async function deleteRecording(partition: PartitionId, id: string) {
    const epoch = mutationEpoch(partition);
    const audio = await chunks(partition, id);
    checkMutation(partition, epoch);
    await partitions.open(partition).write([{ delete: indexKey(id) }, { delete: `recording:accepted:${id}` }, ...audio.map((c) => ({ delete: chunkKey(id, c.index) }))]);
    checkMutation(partition, epoch);
    repaired.delete(identity(partition, id));
    transcripts.delete(identity(partition, id));
    changed(id);
  }
  const transcriptionPath = (id: string) => `${options.root.apiBase()}/voice/recordings/${encodeURIComponent(id)}/transcription`;
  const online = () => options.root.stores.connection.getState().wsStatus === "connected" && options.root.authLock?.state.getState().phase === "active";
  async function updateTranscription(partition: PartitionId, id: string, update: Partial<Index>, eligible?: (row: Recording) => boolean) {
    const epoch = mutationEpoch(partition);
    const release = await acquire();
    try {
      const row = await get(partition, id);
      checkMutation(partition, epoch);
      if (!row || row.state === "accepted") throw new Error(RECORDING_UNAVAILABLE);
      if (eligible && !eligible(row)) return false;
      const { partition: _, ...index } = row;
      await partitions.open(partition).put(indexKey(id), { ...index, ...update });
      checkMutation(partition, epoch);
      if (update.state === "transcript-ready" || update.state === "transcribing") transcripts.add(identity(partition, id));
      changed(id);
      return true;
    } finally { await release(); }
  }
  const receiptSnapshot = (row: Recording) => JSON.stringify([fingerprint(row), row.transcribeRequestId, row.transcription]);
  async function applyReceipt(partition: PartitionId, id: string, result: RecordingTranscription, observed?: Recording) {
    const row = await get(partition, id);
    if (!row || result.recordingId !== id || result.sha256 !== row.contentHash) throw new Error("The transcription does not match this recording. The recording is kept.");
    const message = result.status === "outcome_unknown" ? "The provider may have processed this audio. It cannot be retried. The recording is kept."
      : result.status === "failed" ? result.retryCount >= 3 ? "All three retries have been used. The recording is kept."
        : result.failure?.retryable ? `Transcription failed (${result.failure.reason}). You can choose Retry. The recording is kept.`
        : `Transcription was rejected (${result.failure?.reason ?? "validation"}). It cannot be retried. The recording is kept.`
      : result.status === "consumed" ? "This transcription was already accepted or discarded." : undefined;
    await updateTranscription(partition, id, {
      transcription: result, transcriptionMessage: message,
      state: result.status === "done" ? "transcript-ready" : result.status === "transcribing" ? "transcribing" : "failed",
      ...(result.status === "done" && typeof result.text === "string" ? { transcript: result.text } : {}),
    }, current => current.state !== "transcript-ready" && current.contentHash === result.sha256 && (!observed || receiptSnapshot(current) === receiptSnapshot(observed)));
  }
  async function statusOf(id: string) {
    const response = await options.root.request(transcriptionPath(id), { credentials: "include", cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Could not check transcription status. The recording is kept.");
    return await response.json() as RecordingTranscription;
  }
  async function tombstone(partition: PartitionId, id: string, disposition: "accepted" | "discarded", contacted: boolean) {
    if (!contacted || partition === "unassigned") return;
    // Store the explicit deletion request before losing the local index. Offline
    // acceptance/discard stays local; reconnection can only replay this DELETE.
    await partitions.open(partition).put(`recording:tombstone:${id}`, { id, disposition });
  }
  let syncing = false;
  let syncPending = false;
  const store: RecordingStore = {
    budget,
    sink: () => deferred(),
    async start(env = {}) {
      if (disposed || signingOut || opening || running) throw new Error("Recording is already running or the store is closed");
      opening = true; notify();
      const controller = new AbortController();
      openingAbort = controller;
      const signal = env.signal ? AbortSignal.any([env.signal, controller.signal]) : controller.signal;
      let release: (() => Promise<void>) | undefined;
      try {
        const partition = heldPartition();
        const generation = partitions.writerGeneration(partition);
        openingGeneration = generation;
        release = await acquire();
        const free = await budget();
        if (!free.canRecord) { emit("refused", notEnough); throw new Error(notEnough); }
        signal.throwIfAborted();
        const sink = deferred({ partition, generation, release, signal });
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
      finally { opening = false; openingGeneration = null; openingAbort = null; openingCapture = null; notify(); }
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
    active() {
      const s = running;
      return s && (s.partition === "unassigned" || s.partition === heldPartition()) ? { partition: s.partition, id: s.row.id } : null;
    },
    get,
    async list(partition) {
      const version = inventoryVersion;
      const entries = await partitions.open(partition).list(INDEX);
      checkReadable(partition);
      const rows = (await Promise.all(entries.map(async r => {
        const shown = present(partition, r.value as Index);
        return shown ? acceptedView(partition, shown) : null;
      }))).filter((row): row is Recording => row !== null);
      if (version === inventoryVersion) trackTranscripts(partition, rows);
      return rows;
    },
    async recover(partition) {
      const version = inventoryVersion;
      const epoch = mutationEpoch(partition);
      // Never recover under a live recorder, including a recorder in another tab.
      const release = await acquire();
      let result!: RecordingRecovery;
      try {
        checkMutation(partition, epoch);
        const handle = partitions.open(partition);
        let removedCount = (await handle.get(REMOVED) as number | undefined) ?? 0;
        const recovered: Recording[] = [];
        const removed: Array<{ index: Index; audio: LocalCaptureChunk[] }> = [];
        // Durable headers remain loss witnesses; a matching repair also carries
        // known auth corrections that a full device could not yet commit.
        for (const entry of await handle.list(INDEX)) {
          const index = entry.value as Index;
          const all = await chunks(partition, index.id);
          checkMutation(partition, epoch);
          const kept = contiguousChunks(all);
          if (!kept.length && typeof index.transcript === "string") {
            // Browser audio loss cannot erase independently surviving review
            // text. It remains editable and acceptable without playback.
            const shown: Index = { ...index, state: index.state === "accepted" ? "accepted" : "transcript-ready", bytes: 0, chunkCount: 0, savedThroughMs: 0 };
            try { await handle.write([{ put: indexKey(index.id), value: shown }, ...all.map(c => ({ delete: chunkKey(index.id, c.index) }))]); }
            catch { repaired.set(identity(partition, index.id), { source: fingerprint(index), value: shown }); }
            recovered.push(await acceptedView(partition, shown));
          } else if (!kept.length) {
            removedCount++;
            removed.push({ index, audio: all });
            repaired.set(identity(partition, index.id), { source: fingerprint(index), value: null });
          } else {
            const shown = await recoveredIndex(present(partition, index) ?? index, kept, all.length);
            checkMutation(partition, epoch);
            if (shown !== index) {
              try {
                await handle.write([{ put: indexKey(index.id), value: shown }, ...all.slice(kept.length).map((c) => ({ delete: chunkKey(index.id, c.index) }))]);
              } catch {
                // A full device can still read and play its committed prefix.
                repaired.set(identity(partition, index.id), { source: fingerprint(index), value: shown });
              }
            }
            recovered.push(await acceptedView(partition, shown));
          }
        }
        if (removed.length) {
          checkMutation(partition, epoch);
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
      checkMutation(partition, epoch);
      if (version === inventoryVersion) trackTranscripts(partition, result.recordings);
      return result;
    },
    async dismissRemoved(partition) {
      const epoch = mutationEpoch(partition);
      const release = await acquire();
      try {
        checkMutation(partition, epoch);
        const handle = partitions.open(partition);
        const changes: PartitionWrite[] = [{ delete: REMOVED }];
        const removed: string[] = [];
        for (const entry of await handle.list(INDEX)) {
          const row = entry.value as Index;
          const audio = await chunks(partition, row.id);
          if (!contiguousChunks(audio).length && typeof row.transcript !== "string") {
            changes.push({ delete: indexKey(row.id) }, ...audio.map((c) => ({ delete: chunkKey(row.id, c.index) })));
            removed.push(row.id);
          }
        }
        checkMutation(partition, epoch);
        await handle.write(changes);
        checkMutation(partition, epoch);
        for (const id of removed) repaired.delete(identity(partition, id));
      } finally { await release(); }
    },
    async playback(partition, id) {
      const pending = { partition, id, generation: partitions.writerGeneration(partition), cancelled: false };
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
        if (!sameGeneration(partition, pending.generation)) throw new Error("Recording is no longer available");
        const url = URL.createObjectURL(new Blob(audio.map((c) => c.data), { type: row.mime }));
        urls.set(url, { partition, id, generation: pending.generation });
        return { url, revoke: () => revoke(url) };
      } finally { pendingPlaybacks.delete(pending); }
    },
    async discard(partition, id) {
      const epoch = mutationEpoch(partition);
      checkReadable(partition);
      if (partition === "unassigned") epoch.generation = await partitions.allowUnassignedAction();
      const release = await acquire();
      try {
        checkMutation(partition, epoch);
        const row = await get(partition, id);
        await tombstone(partition, id, "discarded", !!row?.transcribeRequestId);
        await deleteRecording(partition, id);
      } finally { await release(); }
      void store.syncTranscriptions().catch(() => {});
    },
    async saveTranscript(partition, id, text) {
      const epoch = mutationEpoch(partition);
      checkReadable(partition);
      if (partition === "unassigned") epoch.generation = await partitions.allowUnassignedAction();
      const release = await acquire();
      try {
        const row = await get(partition, id);
        checkMutation(partition, epoch);
        if (!row || row.state === "accepted" || row.state === "recording") throw new Error("Recording is not available for review");
        const { partition: _partition, ...index } = row;
        await partitions.open(partition).put(indexKey(id), { ...index, transcript: text, state: "transcript-ready" });
        checkMutation(partition, epoch);
        transcripts.add(identity(partition, id));
        changed(id);
      } finally { await release(); }
    },
    async accept(partition, id, draftId, sessionId, expectedTranscript) {
      // The global recording lock serializes accept, edit, discard and other
      // tabs. A receipt committed with the draft closes the crash window
      // between that commit and accepted metadata / deletion.
      const release = await acquire();
      try {
        checkReadable(partition);
        if (partition === "unassigned" || !options.root.localWork) throw new Error("Link this recording to an account before adding it to a draft");
        const row = await get(partition, id);
        if (!row) throw new Error(RECORDING_UNAVAILABLE);
        if (expectedTranscript !== undefined && expectedTranscript !== row.transcript) throw new Error(TRANSCRIPT_CHANGED);
        if (row.state !== "accepted" && (row.state !== "transcript-ready" || !row.transcript?.trim())) throw new Error("The recording has no transcript to add");
        const revision = await options.root.localWork.addTranscript(id, row.transcript!, draftId, sessionId);
        // Authority may have gone during the draft commit. The audio stays
        // locked until the same account returns; it is never deleted early.
        checkReadable(partition);
        const { partition: _partition, ...index } = row;
        await partitions.open(partition).put(indexKey(id), { ...index, state: "accepted", acceptedDraftRev: revision });
        await tombstone(partition, id, "accepted", !!row.transcribeRequestId);
        await deleteRecording(partition, id);
        void store.syncTranscriptions().catch(() => {});
      } finally {
        // The draft's durable receipt can change reviewability even when
        // accepted metadata or cleanup fails. Refresh every mounted tab.
        changed(id);
        await release();
      }
    },
    async transcribe(partition, id, progress, retry) {
      if (partition === "unassigned" || !online()) throw new Error("Sign in and reconnect before transcribing.");
      if (!navigator.locks) throw new Error("This browser cannot coordinate transcription tabs.");
      await navigator.locks.request(`brain-ui:transcription:${id}`, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error("Transcribing in another Brain tab. The recording is kept.");
        const epoch = mutationEpoch(partition);
        const authEpoch = options.root.authLock.epoch();
        const check = () => { checkMutation(partition, epoch); if (!online() || authEpoch !== options.root.authLock.epoch()) throw new Error("Account or connection changed. The recording is kept."); };
        check();
        const row = await get(partition, id);
        if (!row || !row.chunkCount || row.state === "recording" || row.state === "accepted" || row.state === "transcript-ready") throw new Error(RECORDING_UNAVAILABLE);
        const capabilities = await options.root.request(`${options.root.apiBase()}/voice/capabilities`, { credentials: "include", cache: "no-store" });
        if (!capabilities.ok || !(await capabilities.json()).capabilities?.savedAudio) throw new Error("Saved-audio transcription is unavailable. The recording is kept.");
        check();
        const existing = await statusOf(id); check();
        if (existing) {
          await applyReceipt(partition, id, existing, row); check();
          if (!retry || existing.status !== "failed" || !existing.failure?.retryable || existing.retryCount >= 3 || existing.attemptId !== retry) return;
        } else if (retry) throw new Error("The failed attempt is no longer available. The recording is kept.");
        const audio = (await chunks(partition, id)).slice(0, row.chunkCount);
        check();
        const blob = new Blob(audio.map(c => c.data), { type: row.mime });
        if (await hash(audio.map(c => c.data)) !== row.contentHash) throw new Error("The saved audio changed. The recording is kept.");
        check();
        const uploadRow = await get(partition, id); check();
        if (!uploadRow || uploadRow.state === "transcript-ready" || uploadRow.state === "accepted" || uploadRow.contentHash !== row.contentHash) return;
        if (!await updateTranscription(partition, id, { state: "transcribing", transcribeRequestId: id, transcriptionMessage: undefined }, current => receiptSnapshot(current) === receiptSnapshot(uploadRow))) return;
        let uploaded = false;
        let dispatched = false;
        let definitiveRejection: string | undefined;
        let lastProgress: number | undefined;
        let received = false;
        const controller = new AbortController();
        const unwatch = options.root.stores.connection.subscribe(() => { if (options.heldAccountKey() === null || heldPartition() !== partition) controller.abort(); });
        const unlock = options.root.authLock.state.subscribe(() => { if (options.root.authLock.epoch() !== authEpoch) controller.abort(); });
        try {
          check();
          dispatched = true;
          const response = await options.root.request(`${transcriptionPath(id)}${retry ? `?retry=${encodeURIComponent(retry)}` : ""}`, {
            method: "PUT", credentials: "include", headers: { "content-type": row.mime, "content-sha256": row.contentHash }, body: blob, signal: controller.signal,
            onUploadProgress(percent) { lastProgress = percent; uploaded ||= percent >= 100; progress(percent); },
          });
          checkMutation(partition, epoch);
          if (authEpoch !== options.root.authLock.epoch()) throw new Error("Sign in again");
          uploaded = true;
          const result = await response.json();
          received = response.ok;
          if (response.ok) await applyReceipt(partition, id, result);
          else if (result.receipt) await applyReceipt(partition, id, result.receipt);
          else {
            const preclaim: Record<string, number> = { recording_id_invalid: 400, recording_hash_invalid: 400, recording_empty: 400, recording_too_large: 413, recording_media_unsupported: 415, saved_audio_unsupported: 501, transcription_not_found: 404, transcription_retry_stale: 409 };
            if (preclaim[result.error] === response.status) definitiveRejection = typeof result.message === "string" ? result.message : "The recording was rejected before transcription. The recording is kept.";
            throw new Error(result.message ?? "Could not transcribe. The recording is kept.");
          }
        } catch (error) {
          checkMutation(partition, epoch);
          uploaded ||= dispatched && (lastProgress === undefined || lastProgress <= 0); // Initialization is not evidence of a partial transfer.
          await updateTranscription(partition, id, { state: uploaded && !definitiveRejection ? "transcribing" : "failed", transcriptionMessage: definitiveRejection ?? (uploaded
            ? received ? "Couldn\u0027t save the transcript on this device. The recording is kept." : "Could not confirm the result. Check transcription status after reconnecting. The recording is kept."
            : "Not sent — tap Transcribe again") }, current => current.state === "transcribing" && current.contentHash === row.contentHash);
          throw error;
        } finally { unwatch(); unlock(); }
      });
    },
    async syncTranscriptions() {
      if (syncing) { syncPending = true; return; }
      if (!online() || heldPartition() === "unassigned" || disposed) return;
      syncing = true;
      const partition = heldPartition();
      const epoch = mutationEpoch(partition);
      try {
        for (const entry of await partitions.open(partition).list("recording:tombstone:")) {
          checkMutation(partition, epoch);
          const value = entry.value as { id: string; disposition: string };
          const response = await options.root.request(`${transcriptionPath(value.id)}?disposition=${value.disposition}`, { method: "DELETE", credentials: "include" });
          checkMutation(partition, epoch);
          if (response.ok) await partitions.open(partition).write([{ delete: entry.key }]);
        }
        for (const row of await store.list(partition)) {
          if (!row.transcribeRequestId || !["transcribing", "failed"].includes(row.state)) continue;
          if (!navigator.locks) continue;
          // A 404 before the active upload finishes says nothing about whether
          // that upload will dispatch. Recover only after its id lock is free.
          await navigator.locks.request(`brain-ui:transcription:${row.id}`, { ifAvailable: true }, async lock => {
            if (!lock) return;
            checkMutation(partition, epoch);
            const result = await statusOf(row.id); checkMutation(partition, epoch);
            if (result) await applyReceipt(partition, row.id, result, row);
            // A lost PUT may still be reading on the host before its claim.
            // Missing status cannot prove it was not sent; keep polling.
          });
        }
      } finally {
        syncing = false;
        if (syncPending) { syncPending = false; await store.syncTranscriptions(); }
      }
    },
    async assign(id) {
      if (signingOut) throw new Error("Signing out");
      const to = heldPartition();
      const authEpoch = options.root.authLock.epoch();
      const unassignedEpoch = mutationEpoch("unassigned");
      const authorized = () => { checkMutation("unassigned", unassignedEpoch); if (authEpoch !== options.root.authLock.epoch() || options.root.authLock.state.getState().phase !== "active" || heldPartition() !== to || signingOut) throw new PartitionRefusedError(to); };
      if (to === "unassigned") throw new Error("Sign in before associating a recording");
      authorized();
      unassignedEpoch.generation = await partitions.allowUnassignedAction();
      const release = await acquire();
      try {
        authorized();
        const row = await get("unassigned", id);
        if (!row) throw new Error("Unassigned recording not found");
        const audio = await chunks("unassigned", id);
        const kept = contiguousChunks(audio);
        if (!kept.length) throw new Error("Unassigned recording has no playable audio");
        const { partition: _partition, ...index } = row;
        const shown = await recoveredIndex(index, kept, audio.length);
        // Commit the recovered view before moving its durable records. When
        // storage is still full, association fails and leaves the source kept.
        authorized();
        await partitions.open("unassigned").write([{ put: indexKey(id), value: shown }, ...audio.slice(kept.length).map((c) => ({ delete: chunkKey(id, c.index) }))]);
        authorized();
        await partitions.move("unassigned", to, [indexKey(id), ...kept.map((c) => chunkKey(id, c.index))]);
        authorized();
        repaired.delete(identity("unassigned", id));
        changed(id);
      } finally { await release(); }
    },
    async clearForSignOut(partition, alsoUnassigned, clearAccount) {
      if (partition === "unassigned" || (!clearAccount && partition !== heldPartition())) throw new PartitionRefusedError(partition);
      signingOut = true;
      await store.stop("auth");
      // Native partition fences serialize deletion with earlier writes and
      // refuse later writes. A different account's live capture owns the
      // global microphone lock, but must not delay this account's sign-out.
      const results = await Promise.allSettled([
        clearAccount ? clearAccount() : partitions.clear(partition),
        ...(alsoUnassigned ? [Promise.resolve().then(() => partitions.prepareSignOut("unassigned")())] : []),
      ]);
      if (results[0]?.status === "fulfilled") changed({ partition, closed: closedFences.get(partition) });
      if (alsoUnassigned && results[1]?.status === "fulfilled") changed({ partition: "unassigned", closed: closedFences.get("unassigned") });
      if (results.some(r => r.status === "rejected")) throw new Error("Local work could not be completely deleted.");
      repaired.clear(); transcripts.clear(); notify();
    },
    busy: () => opening || beginning !== null || running !== null || transcripts.size > 0,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    onEvent(fn) { events.add(fn); return () => { events.delete(fn); }; },
    dispose() { disposed = true; unwatchSignOut(); unwatchAccount(); unwatchInventory(); unwatchAuth(); invalidators.delete(invalidate); channel?.close(); repaired.clear(); for (const url of urls.keys()) revoke(url); void store.stop("interrupted").finally(releaseHold); },
  };
  function scan() {
    for (const p of new Set<PartitionId>(["unassigned", heldPartition()])) void store.list(p).catch(() => {});
  }
  const unwatchSignOut = partitions.subscribeSignOut((id, closed, affectsWriter) => {
    if (sameGeneration(id, closed.token)) closedFences.set(id, closed);
    if (affectsWriter) mutationEpochs.set(id, (mutationEpochs.get(id) ?? 0) + 1);
    invalidate({ partition: id, closed });
    if (running?.partition === id && closedGeneration(closed, running.generation)
      || beginning?.partition === id && closedGeneration(closed, beginning.generation)
      || opening && heldPartition() === id && openingGeneration !== null && closedGeneration(closed, openingGeneration)) {
      if (running?.partition === id) { running.authInterrupted = true; running.accepting = false; }
      void store.stop("interrupted");
    }
  });
  const recoverTranscriptions = () => { scan(); if (!disposed) void store.syncTranscriptions().catch(() => {}); };
  const unwatchInventory = options.root.stores.connection.subscribe(recoverTranscriptions);
  let unwatchAuth = () => {};
  scan();
  const releaseHold = registerUpdateHold(options.root, store);
  queueMicrotask(() => { if (!disposed) { unwatchAuth = options.root.authLock.state.subscribe(recoverTranscriptions); recoverTranscriptions(); } });
  return store;
}
