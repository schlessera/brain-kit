/**
 * Local audio capture (#1012, #578 T1): the microphone recorded on the device,
 * with no server voice session and no network request at any point.
 *
 * The engine opens the microphone only when `startLocalCapture` is called, and
 * the composer calls it only from a tap. Each encoded chunk goes to a sink,
 * with its start and end in milliseconds from the start of the recording; the
 * durable sink is #1017's. `stop(reason)` is how a caller ends the recording
 * for the 10-minute limit, a storage failure or an auth expiry.
 *
 * The chunk interval is a tuning default, not a promise: what was saved is
 * whatever the sink committed, and no copy names the interval.
 */

/** The containers local capture records in, in order of preference. */
export const LOCAL_CAPTURE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4"] as const;
export type LocalCaptureMimeType = (typeof LOCAL_CAPTURE_MIME_TYPES)[number];

/** The chunk interval MediaRecorder is asked for. Tuning only; never shown. */
export const LOCAL_CAPTURE_TIMESLICE_MS = 1000;

/**
 * Why a recording ended. `interrupted` is the browser ending it on its own:
 * the track ended (an OS interruption, the device went away) or the recorder
 * failed.
 */
export type LocalCaptureStopReason = "user" | "limit" | "storage" | "auth" | "interrupted";

export interface LocalCaptureChunk {
  /** 0 for the first chunk of a recording, then 1, 2, … */
  index: number;
  data: Blob;
  /** Milliseconds from the start of the recording. */
  startMs: number;
  endMs: number;
}

/**
 * Where a recording's chunks go. Calls are made one at a time, in order: a
 * chunk is not handed over until the previous call's promise settled. A
 * rejected call stops the recording with the reason `storage`.
 */
export interface LocalCaptureSink {
  /** Once, before the first chunk, with the container the recorder chose. */
  begin?(info: { mimeType: LocalCaptureMimeType }): void | Promise<void>;
  chunk(chunk: LocalCaptureChunk): void | Promise<void>;
  /** Once, after the final chunk and after the microphone was released. */
  end?(reason: LocalCaptureStopReason): void | Promise<void>;
}

export interface LocalCapture {
  readonly mimeType: LocalCaptureMimeType;
  /**
   * Ends the recording. Resolves once the final chunk was handed to the sink
   * (and its call settled) and every track of the MediaStream has ended. A
   * second call returns the first call's promise and keeps its reason.
   */
  stop(reason: LocalCaptureStopReason): Promise<LocalCaptureStopReason>;
  /** Settles with the reason once the recording ended, however it ended. */
  readonly ended: Promise<LocalCaptureStopReason>;
}

export interface LocalCaptureEnvironment {
  mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  MediaRecorder?: typeof MediaRecorder;
  now?: () => number;
}

export interface StartLocalCaptureOptions extends LocalCaptureEnvironment {
  /** Nothing reaches it before the microphone opened and the start was not aborted. */
  sink: LocalCaptureSink;
  timesliceMs?: number;
  /**
   * Cancels a start still waiting on the microphone: the stream it gets is
   * released, nothing records and the sink is never called.
   */
  signal?: AbortSignal;
}

/** The first container this browser's MediaRecorder records, or null. */
export function pickLocalCaptureMimeType(Recorder: typeof MediaRecorder | undefined = globalThis.MediaRecorder): LocalCaptureMimeType | null {
  if (typeof Recorder?.isTypeSupported !== "function") return null;
  return LOCAL_CAPTURE_MIME_TYPES.find((type) => Recorder.isTypeSupported(type)) ?? null;
}

/**
 * Opens the microphone and starts recording. Rejects with the browser's own
 * error when the microphone cannot be opened (a `NotAllowedError` for a
 * denied permission), and releases anything it opened before rejecting.
 */
export async function startLocalCapture(options: StartLocalCaptureOptions): Promise<LocalCapture> {
  const Recorder = options.MediaRecorder ?? globalThis.MediaRecorder;
  const mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
  const now = options.now ?? (() => performance.now());
  const mimeType = pickLocalCaptureMimeType(Recorder);
  if (!mimeType || !mediaDevices?.getUserMedia) {
    throw new DOMException("This browser can't record audio on the device.", "NotSupportedError");
  }
  options.signal?.throwIfAborted();
  const stream = await mediaDevices.getUserMedia({ audio: true });
  const release = () => { for (const track of stream.getTracks()) track.stop(); };
  if (options.signal?.aborted) {
    release();
    options.signal.throwIfAborted();
  }
  let recorder: MediaRecorder;
  try {
    recorder = new Recorder(stream, { mimeType });
  } catch (err) {
    release();
    throw err;
  }

  const sink = options.sink;
  // One call at a time, in order: the sink sees chunks exactly as recorded.
  let sinkFailed = false;
  const failSink = () => {
    // The sink could not take it: stop rather than keep recording audio
    // nothing will hold.
    if (sinkFailed) return;
    sinkFailed = true;
    void finish("storage");
  };
  let delivery: Promise<void> = Promise.resolve().then(() => sink.begin?.({ mimeType })).then(() => undefined, failSink);
  let index = 0;
  let startedAt = 0;
  let lastEnd = 0;
  let reason: LocalCaptureStopReason | null = null;
  let resolveEnded!: (reason: LocalCaptureStopReason) => void;
  const ended = new Promise<LocalCaptureStopReason>((resolve) => { resolveEnded = resolve; });
  let stopping: Promise<LocalCaptureStopReason> | null = null;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

  const deliver = (data: Blob) => {
    // After a sink failure nothing more is handed over: the sink said it
    // cannot hold audio, and a later chunk would leave a gap behind it.
    if (data.size === 0 || sinkFailed) return;
    // Strictly after the previous chunk, even when two arrive in the same
    // millisecond (a periodic chunk, then the one stop flushes).
    const endMs = Math.max(lastEnd + 1, Math.round(now() - startedAt));
    const chunk: LocalCaptureChunk = { index: index++, data, startMs: lastEnd, endMs };
    lastEnd = endMs;
    delivery = delivery.then(() => sinkFailed ? undefined : sink.chunk(chunk)).then(() => undefined, failSink);
  };

  recorder.addEventListener("dataavailable", (event) => deliver((event as BlobEvent).data));
  recorder.addEventListener("stop", () => {
    resolveStopped();
    // A stop nobody asked for: the stream's tracks were stopped elsewhere,
    // which fires no `ended` on them.
    void finish("interrupted");
  });
  // The browser ending the recording on its own (the track ended, an error):
  // finish it the same way a caller would.
  recorder.addEventListener("error", () => void finish("interrupted"));
  for (const track of stream.getTracks()) {
    track.addEventListener("ended", () => void finish("interrupted"));
  }

  function finish(why: LocalCaptureStopReason): Promise<LocalCaptureStopReason> {
    if (stopping) return stopping;
    reason = why;
    stopping = (async () => {
      // The final dataavailable fires before stop. A recorder the browser
      // already stopped still has its stop event to come.
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      release();
      await delivery;
      try {
        await sink.end?.(reason!);
      } catch {
        // The recording has ended either way; the sink reports its own failure.
      }
      resolveEnded(reason!);
      return reason!;
    })();
    return stopping;
  }

  try {
    recorder.start(options.timesliceMs ?? LOCAL_CAPTURE_TIMESLICE_MS);
  } catch (err) {
    release();
    throw err;
  }
  startedAt = now();

  return {
    mimeType,
    stop: (why) => finish(why),
    ended,
  };
}

export interface LocalCaptureSupport {
  supported: boolean;
  mimeType: LocalCaptureMimeType | null;
  /** What failed, for diagnostics; empty when supported. */
  missing: ("secure-context" | "media-recorder" | "microphone" | "indexeddb")[];
}

/**
 * Whether this page can record on the device: MediaRecorder records one of
 * the two containers, IndexedDB accepts a Blob in a probe write (a private
 * mode that blocks storage fails here), and the page is a secure context.
 * Never touches the microphone.
 */
export async function detectLocalCaptureSupport(env: LocalCaptureEnvironment & {
  isSecureContext?: boolean;
  indexedDB?: IDBFactory;
} = {}): Promise<LocalCaptureSupport> {
  const missing: LocalCaptureSupport["missing"] = [];
  const secure = env.isSecureContext ?? globalThis.isSecureContext === true;
  if (!secure) missing.push("secure-context");
  const mimeType = pickLocalCaptureMimeType(env.MediaRecorder ?? globalThis.MediaRecorder);
  if (!mimeType) missing.push("media-recorder");
  const mediaDevices = env.mediaDevices ?? globalThis.navigator?.mediaDevices;
  if (typeof mediaDevices?.getUserMedia !== "function") missing.push("microphone");
  const idb = env.indexedDB ?? globalThis.indexedDB;
  if (!idb || !(await probeBlobWrite(idb))) missing.push("indexeddb");
  return { supported: missing.length === 0, mimeType, missing };
}

const PROBE_DB = "brain-ui:local-capture-probe";

/** Writes a one-byte Blob to a throwaway database, then deletes the database. */
async function probeBlobWrite(idb: IDBFactory): Promise<boolean> {
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = idb.open(PROBE_DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore("probe");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error("blocked"));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("probe", "readwrite");
        tx.objectStore("probe").put(new Blob([new Uint8Array([0])], { type: "application/octet-stream" }), "blob");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      return true;
    } finally {
      db.close();
      await new Promise<void>((resolve) => {
        const removal = idb.deleteDatabase(PROBE_DB);
        removal.onsuccess = removal.onerror = removal.onblocked = () => resolve();
      });
    }
  } catch {
    return false;
  }
}
