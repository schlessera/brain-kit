// In-page half of the #1010 committed-boundary probe. probe.mjs serves it as a
// plain module; nothing here is imported by a published package.
//
// One recording = one row in `recordings` (the index) plus one row per
// MediaRecorder chunk in `chunks`. Each chunk is written in its own IndexedDB
// transaction that also advances the index's `savedThroughMs`, so the index
// never claims audio whose chunk did not commit with it.
//
// `savedThroughMs` for a chunk is the wall time at which MediaRecorder
// delivered it, measured from the recorder's `start` event: the end of the
// audio that chunk can contain.

const DB = "v1-commit-boundary";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("recordings", { keyPath: "id" });
      db.createObjectStore("chunks", { keyPath: ["id", "seq"] });
      db.createObjectStore("filler", { keyPath: "n" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException("aborted", "AbortError"));
  });
}

function request(store, method, ...args) {
  return new Promise((resolve, reject) => {
    const req = store[method](...args);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/mp4;codecs=opus",
  'audio/mp4;codecs="mp4a.40.2"',
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

const live = {
  recorder: null,
  stream: null,
  id: null,
  mime: null,
  startWall: null,
  events: [],
  delivered: 0,
  deliveredWhileHidden: 0,
  committed: [],
  writeErrors: [],
  stopWall: null,
  stoppedBy: null,
  drained: false,
};

function log(type, extra = {}) {
  live.events.push({ type, wall: Date.now(), visibility: document.visibilityState, ...extra });
}

document.addEventListener("visibilitychange", () => log("visibilitychange"));
document.addEventListener("freeze", () => log("freeze"));
document.addEventListener("resume", () => log("resume"));

async function capabilities() {
  const mime = {};
  for (const type of MIME_CANDIDATES) mime[type] = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type);
  let defaultMime = null;
  let blobRoundTrip;
  try {
    const db = await openDb();
    const bytes = new Uint8Array([1, 2, 3, 4, 250, 251, 252, 253]);
    const tx = db.transaction("filler", "readwrite");
    tx.objectStore("filler").put({ n: -1, blob: new Blob([bytes], { type: "audio/webm" }) });
    await done(tx);
    const back = await request(db.transaction("filler").objectStore("filler"), "get", -1);
    const read = new Uint8Array(await back.blob.arrayBuffer());
    blobRoundTrip = {
      ok: back.blob instanceof Blob && read.length === bytes.length && read.every((b, i) => b === bytes[i]),
      type: back.blob.type,
    };
    const clear = db.transaction("filler", "readwrite");
    clear.objectStore("filler").delete(-1);
    await done(clear);
    db.close();
  } catch (error) {
    blobRoundTrip = { ok: false, error: `${error?.name}: ${error?.message}` };
  }
  if (typeof MediaRecorder !== "undefined") {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      await new Promise((resolve) => {
        recorder.onstart = resolve;
        recorder.start();
      });
      defaultMime = recorder.mimeType;
      recorder.stop();
      for (const track of stream.getTracks()) track.stop();
    } catch (error) {
      defaultMime = `failed: ${error?.name}: ${error?.message}`;
    }
  }
  const storage = {};
  if (navigator.storage?.persist) {
    try {
      // Firefox answers persist() through a permission prompt; an automated
      // run never answers it, so an unsettled promise is reported as such.
      storage.persist = await Promise.race([
        navigator.storage.persist(),
        new Promise((resolve) => setTimeout(() => resolve("unsettled after 3000 ms"), 3000)),
      ]);
    } catch (error) {
      storage.persist = `throws ${error?.name}`;
    }
  } else storage.persist = "unavailable";
  storage.persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : "unavailable";
  if (navigator.storage?.estimate) {
    const { quota, usage } = await navigator.storage.estimate();
    storage.estimate = { quota, usage };
  } else storage.estimate = "unavailable";
  return {
    userAgent: navigator.userAgent,
    mediaRecorder: typeof MediaRecorder !== "undefined",
    getUserMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
    mime,
    defaultMime,
    blobRoundTrip,
    storage,
  };
}

async function estimate() {
  const { quota, usage } = await navigator.storage.estimate();
  return { quota, usage };
}

async function start({ id, timesliceMs, mime }) {
  live.id = id;
  const db = await openDb();
  // The capture device is the browser's fake microphone (see probe.mjs), so
  // this is the same getUserMedia -> MediaRecorder path a real tap takes.
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  live.stream = stream;
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  live.recorder = recorder;
  let chain = Promise.resolve();
  let seq = 0;

  const index = (patch) => ({
    id,
    mime: live.mime,
    timesliceMs,
    startWall: live.startWall,
    savedThroughMs: 0,
    chunks: 0,
    state: "recording",
    ...patch,
  });

  const stopFor = (reason) => {
    if (recorder.state === "inactive" || live.stoppedBy) return;
    live.stopWall = Date.now();
    live.stoppedBy = reason;
    recorder.stop();
  };

  recorder.ondataavailable = (event) => {
    const deliveredWall = Date.now();
    live.delivered++;
    if (document.visibilityState === "hidden") live.deliveredWhileHidden++;
    log("dataavailable", { size: event.data.size, recorderState: recorder.state });
    if (event.data.size === 0) return;
    const mySeq = seq++;
    const endMs = deliveredWall - live.startWall;
    const final = recorder.state === "inactive";
    chain = chain.then(async () => {
      if (live.writeErrors.length) return;
      try {
        const tx = db.transaction(["chunks", "recordings"], "readwrite");
        tx.objectStore("chunks").put({ id, seq: mySeq, blob: event.data, size: event.data.size, endMs, deliveredWall });
        tx.objectStore("recordings").put(
          index({
            savedThroughMs: endMs,
            chunks: mySeq + 1,
            lastCommitWall: Date.now(),
            state: final ? `stopped:${live.stoppedBy ?? "unknown"}` : "recording",
          })
        );
        await done(tx);
        live.committed.push({ seq: mySeq, endMs, committedWall: Date.now(), final });
      } catch (error) {
        live.writeErrors.push({ seq: mySeq, wall: Date.now(), name: error?.name, message: String(error?.message) });
        log("write-error", { name: error?.name });
        stopFor("write-error");
      }
    });
  };
  recorder.onstop = () => {
    log("recorder-stop");
    if (!live.stoppedBy) {
      live.stopWall = Date.now();
      live.stoppedBy = "recorder-stopped-itself";
    }
    chain = chain.then(() => {
      live.drained = true;
      log("chain-drained-after-stop");
    });
  };
  recorder.onerror = (event) => log("recorder-error", { name: event.error?.name });
  for (const track of stream.getTracks()) {
    track.addEventListener("ended", () => log("track-ended"));
    track.addEventListener("mute", () => log("track-mute"));
  }

  await new Promise((resolve) => {
    recorder.onstart = () => {
      live.startWall = Date.now();
      live.mime = recorder.mimeType;
      log("recorder-start");
      resolve();
    };
    recorder.start(timesliceMs);
  });
  const tx = db.transaction("recordings", "readwrite");
  tx.objectStore("recordings").put(index({}));
  await done(tx);
  return { startWall: live.startWall, mime: live.mime };
}

/** Simulated microphone interruption: the capture track ends under the recorder. */
function interruptTrack() {
  live.stopWall = Date.now();
  live.stoppedBy = "track-ended";
  for (const track of live.stream.getTracks()) track.stop();
  log("tracks-stopped", { recorderState: live.recorder.state });
  return live.stopWall;
}

function snapshot() {
  return {
    id: live.id,
    mime: live.mime,
    startWall: live.startWall,
    recorderState: live.recorder?.state ?? null,
    delivered: live.delivered,
    deliveredWhileHidden: live.deliveredWhileHidden,
    committed: live.committed.length,
    lastCommitted: live.committed.at(-1) ?? null,
    writeErrors: live.writeErrors,
    stopWall: live.stopWall,
    stoppedBy: live.stoppedBy,
    drained: live.drained,
    visibility: document.visibilityState,
    events: live.events,
  };
}

/** Read what survived the interruption, from a fresh page. */
async function read(id) {
  let db;
  try {
    db = await openDb();
  } catch (error) {
    return { indexReadable: false, error: `${error?.name}: ${error?.message}` };
  }
  const index = (await request(db.transaction("recordings").objectStore("recordings"), "get", id)) ?? null;
  const chunks = (await request(db.transaction("chunks").objectStore("chunks"), "getAll"))
    .filter((c) => c.id === id)
    .sort((a, b) => a.seq - b.seq);
  let readableChunks = 0;
  let bytes = 0;
  const parts = [];
  for (const chunk of chunks) {
    try {
      const buffer = await chunk.blob.arrayBuffer();
      if (buffer.byteLength === chunk.size) readableChunks++;
      bytes += buffer.byteLength;
      parts.push(buffer);
    } catch {
      // An unreadable chunk shows up as readableChunks < chunkRows.
    }
  }
  let decodedMs = null;
  let decodeError = null;
  if (parts.length) {
    try {
      const joined = await new Blob(parts).arrayBuffer();
      const audio = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(joined);
      decodedMs = Math.round(audio.duration * 1000);
    } catch (error) {
      decodeError = `${error?.name}: ${error?.message}`;
    }
  }
  db.close();
  return {
    indexReadable: true,
    index,
    chunkRows: chunks.length,
    readableChunks,
    bytes,
    contiguous: chunks.every((c, i) => c.seq === i),
    lastChunkEndMs: chunks.at(-1)?.endMs ?? null,
    chunkEndsMs: chunks.map((c) => c.endMs),
    decodedMs,
    decodeError,
  };
}

window.probe = { capabilities, estimate, start, interruptTrack, snapshot, read };
window.probeReady = true;
