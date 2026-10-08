import { useState } from "react";
import { SlidePanel } from "../../src/components/layout/slide-panel.js";
import { DictationSheet } from "../../src/components/voice/dictation-sheet.js";
import { createRoot } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { ConnectionGate } from "../../src/components/connectivity/connection-gate.js";
import { PasskeyTab } from "../../src/components/settings/passkey-tab.js";
import { RecordingsTray } from "../../src/components/voice/recordings-tray.js";
import { createLocalPartitions, type PartitionId, type LocalPartitions } from "../../src/lib/local-partitions.js";
import { generateWav, AUDIO_FIXTURES } from "../browser/offline/audio-fixtures.js";
import { failIndexedDbWrites, holdIndexedDbWrite } from "../browser/offline/indexeddb-faults.js";
import { updateHeld } from "../../src/lib/update-holds.js";
import { tracksFor, trackKey } from "../../src/lib/draft-tracks.js";

const root = createBrainUiRoot({ storagePrefix: "odysseus-association-signout", localCapture: true, config: { appName: "Odysseus’s notebook" } });
let compose = () => {};
let replaceRoot = async () => {};
let shownRoot = root;
let settingsClosed = 0, dictationCancelled = 0;
function Fixture() {
  const [composed, setComposed] = useState(false);
  const [providedRoot, setProvidedRoot] = useState(root);
  replaceRoot = async () => {
    shownRoot = createBrainUiRoot({ storagePrefix: "odysseus-replacement-root", localCapture: true });
    // Mount an already probed root, as a consumer may do without remounting its tray.
    const response = await shownRoot.request(shownRoot.backendUrl("/api/vpn-check"));
    if (!response.ok) throw new Error("The replacement host did not authenticate");
    const { accountKey } = await response.json();
    shownRoot.stores.connection.getState().setVpnStatus("connected", accountKey);
    setProvidedRoot(shownRoot);
  };
  compose = () => setComposed(true);
  return <BrainUiProvider root={providedRoot}><ConnectionGate>{composed ? <>
    <DictationSheet open onStop={() => {}} onCancel={() => { dictationCancelled++; root.stores.voice.getState().resetCapture(); }} />
    <SlidePanel open title="Settings" onClose={() => { settingsClosed++; }}><PasskeyTab active /></SlidePanel>
  </> : <div style={{ maxWidth: 720, marginInline: "auto", padding: 12 }}><RecordingsTray /><PasskeyTab active /></div>}</ConnectionGate></BrainUiProvider>;
}
createRoot(document.getElementById("app")!).render(<Fixture />);
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (error: Error) => error.name);
const raw = (partition: PartitionId) => createLocalPartitions({ name: "brain-ui-local", heldAccountKey: () => partition === "unassigned" ? null : partition.slice(8) }).open(partition);
async function readDisk(partition: PartitionId): Promise<Array<{key:string;value:unknown}>> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("brain-ui-local", 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  try {
    const store = db.transaction("records", "readonly").objectStore("records");
    const range = IDBKeyRange.bound([partition, ""], [partition, "\uffff"]);
    const valuesPending = new Promise<unknown[]>((resolve,reject)=>{const r=store.getAll(range);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const keysPending = new Promise<IDBValidKey[]>((resolve,reject)=>{const r=store.getAllKeys(range);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const [values, keys] = await Promise.all([valuesPending, keysPending]);
    return keys.map((k,i)=>({key:(k as string[])[1]!,value:values[i]}));
  } finally { db.close(); }
}
let authorized: Awaited<ReturnType<typeof root.localWorkFlow.loss>> | null = null;
let snapshotCalls = 0;
const snapshotNow = root.localWork!.snapshotNow;
root.localWork!.snapshotNow = (...args) => { snapshotCalls++; return snapshotNow(...args); };
let staleParts: LocalPartitions | null = null;
let staleKey = "";
let staleWrite: (() => Promise<string>) | null = null;
let lockHeld = false;
let releaseLock: (() => void) | null = null;
let pendingWrite: Promise<unknown> = Promise.resolve();
let fault: ReturnType<typeof failIndexedDbWrites> | null = null;
let hold: ReturnType<typeof holdIndexedDbWrite> | null = null;
const unassignedFenceKey = `brain-ui:account-write-fence:${encodeURIComponent("brain-ui-local")}:unassigned`;
let pausedClear: (() => Promise<void>) | null = null;
let pausedMarker: string | null = null;
let admission: Promise<string> | null = null;
let resumeAdmission = () => {};
let staleUnassigned: ReturnType<LocalPartitions["open"]> | null = null;
let coldReader: ReturnType<typeof createBrainUiRoot> | null = null;
let coldUrl = "";
let pendingCold: Promise<string> | null = null;
let releaseCold = () => {};
let pendingMutation: Promise<string> | null = null;
let releaseMutation = () => {};
let clearWaiting = false;
let releaseUnassignedClear = () => {};
let coldRefreshes = 0;
let peerQueryWaiting = false;
let releasePeerQuery = () => {};
const delayedStorageEvents: StorageEvent[] = [];
const deferStorage = (event: StorageEvent) => { if (event.key === unassignedFenceKey) { event.stopImmediatePropagation(); delayedStorageEvents.push(event); } };
async function staleAdministrative(operation: () => Promise<string>) {
  const get = Storage.prototype.getItem;
  Storage.prototype.getItem = function(key) { return key === unassignedFenceKey ? pausedMarker : get.call(this, key); };
  try { return await operation(); } finally { Storage.prototype.getItem = get; }
}
Object.assign(window, { __work: {
  replaceRoot: () => replaceRoot(),
  replacementReady: () => shownRoot !== root && !!shownRoot.stores.connection.getState().accountKey && shownRoot.stores.connection.getState().vpnStatus === "connected",
  replacementHasSignIn: () => shownRoot.localWorkFlow.hasSignIn(),
  holdPeerQuery: () => {
    const query = navigator.locks.query.bind(navigator.locks);
    navigator.locks.query = async () => { const snapshot = await query(); peerQueryWaiting = true; await new Promise<void>(resolve => { releasePeerQuery = resolve; }); return snapshot; };
  },
  peerQueryWaiting: () => peerQueryWaiting,
  releasePeerQuery: () => releasePeerQuery(),
  failUnassignedClear: () => {
    const original = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function(query) {
      if (this.name === "records" && query instanceof IDBKeyRange && Array.isArray(query.lower) && query.lower[0] === "unassigned") throw new DOMException("Scripted unassigned clear failure", "QuotaExceededError");
      return original.call(this, query);
    };
  },
  holdUnassignedWriter: async () => { staleUnassigned = createLocalPartitions({ name: "brain-ui-local", heldAccountKey: () => null }).open("unassigned"); await staleUnassigned.write([]); },
  staleUnassignedWrite: () => outcome(staleUnassigned!.put("old-writer:aeolus", "An old writer must remain refused.")),
  recoveryAction: (action: "associate" | "discard" | "transcript", id: string) => outcome(action === "associate" ? root.recordings!.assign(id) : action === "discard" ? root.recordings!.discard("unassigned", id) : root.recordings!.saveTranscript("unassigned", id, "Aeolus keeps the bag sealed.")),
  mountColdReader: async (delayStorage = false) => {
    // Model a frozen peer whose native reads resume before queued storage
    // events. Other roots keep their real listeners and the DB stays native.
    if (delayStorage) window.addEventListener("storage", deferStorage, true);
    coldReader = createBrainUiRoot({ storagePrefix: "odysseus-cold-reader", localCapture: true });
    const list = coldReader.recordings!.list;
    coldReader.recordings!.list = async partition => { const rows = await list(partition); if (partition === "unassigned") coldRefreshes++; return rows; };
    const el = document.createElement("div"); el.dataset.coldReader = ""; document.body.append(el);
    createRoot(el).render(<BrainUiProvider root={coldReader}><RecordingsTray /></BrainUiProvider>);
    await coldReader.localWork!.restoring();
  },
  coldKey: () => coldReader!.stores.connection.getState().accountKey,
  coldPlayback: async () => { coldUrl = (await coldReader!.recordings!.playback("unassigned", "sirens")).url; },
  coldStart: async () => { await coldReader!.recordings!.start({ timesliceMs: 60_000 }); },
  coldActive: () => coldReader!.recordings!.active(),
  coldStop: () => coldReader!.recordings!.stop("user"),
  cacheShell: async () => {
    await navigator.serviceWorker.register("/signout-worker.js");await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => { navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }); });
  },
  coldPlayable: async () => { try { const response = await fetch(coldUrl); return response.ok && (await response.blob()).size > 0; } catch { return false; } },
  stageColdPlayback: async () => {
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { releaseCold = resolve; });
    const open = coldReader!.partitions!.open; let reads = 0;
    coldReader!.partitions!.open = partition => {
      const handle = open(partition);
      return { ...handle, async get(key) { const value = await handle.get(key); if (key === "recording:index:sirens" && ++reads === 2) { started(); await held; } return value; } };
    };
    pendingCold = outcome(coldReader!.recordings!.playback("unassigned", "sirens"));
    await ready;
  },
  releaseColdPlayback: () => { releaseCold(); return pendingCold!; },
  stageColdTranscript: async () => {
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { releaseMutation = resolve; });
    const open = coldReader!.partitions!.open;
    coldReader!.partitions!.open = partition => {
      const handle = open(partition);
      return { ...handle, async get(key) { const value = await handle.get(key); if (key === "recording:index:sirens") { started(); await held; } return value; } };
    };
    pendingMutation = outcome(coldReader!.recordings!.saveTranscript("unassigned", "sirens", "This old transcript must never commit."));
    await ready;
  },
  coldRecovery: () => outcome(coldReader!.recordings!.saveTranscript("unassigned", "aeolus", "Aeolus closes the bag.")),
  releaseColdTranscript: () => { releaseMutation(); return pendingMutation!; },
  stageUnassignedClear: () => {
    const prepare = root.partitions!.prepareSignOut;
    root.partitions!.prepareSignOut = partition => {
      const clear = prepare(partition);
      if (partition !== "unassigned") return clear;
      return async () => { clearWaiting = true; await new Promise<void>(resolve => { releaseUnassignedClear = resolve; }); await clear(); };
    };
  },
  clearWaiting: () => clearWaiting,
  releaseUnassignedClear: () => releaseUnassignedClear(),
  coldRefreshes: () => coldRefreshes,
  flushColdStorage: () => {
    window.removeEventListener("storage", deferStorage, true);
    for (const event of delayedStorageEvents.splice(0)) window.dispatchEvent(new StorageEvent("storage", { key: event.key, oldValue: event.oldValue, newValue: event.newValue, storageArea: event.storageArea, url: event.url }));
  },
  prepareUnassignedClear: () => { pausedClear = createLocalPartitions({ name: "brain-ui-local", heldAccountKey: () => null }).prepareSignOut("unassigned"); pausedMarker = localStorage.getItem(unassignedFenceKey); },
  staleUnassignedClear: () => staleAdministrative(() => outcome(pausedClear!())),
  clearUnassigned: () => createLocalPartitions({ name: "brain-ui-local", heldAccountKey: () => null }).prepareSignOut("unassigned")(),
  unassignedClosed: () => root.partitions!.isSignOutCleared("unassigned"),
  stageAdmission: async () => {
    let opened!: () => void; const ready = new Promise<void>(resolve => { opened = resolve; });
    const factory = new Proxy(indexedDB, { get(target, property) {
      if (property !== "open") { const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value; }
      return (...args: Parameters<IDBFactory["open"]>) => {
        const req = target.open(...args);
        return new Proxy(req, { get(request, key) { const value = Reflect.get(request, key, request); return typeof value === "function" ? value.bind(request) : value; },
          set(request, key, value) {
            if (key === "onsuccess") { request.onsuccess = event => { resumeAdmission = () => value.call(request, event); opened(); }; return true; }
            return Reflect.set(request, key, value, request);
          },
        });
      };
    } });
    admission = outcome(createLocalPartitions({ name: "brain-ui-local", heldAccountKey: () => null, factory }).allowUnassignedAction());
    await ready; pausedMarker = localStorage.getItem(unassignedFenceKey);
  },
  finishStaleAdmission: () => staleAdministrative(() => { resumeAdmission(); return admission!; }),
  vpn: () => root.stores.connection.getState().vpnStatus,
  probe: () => root.recheckVpn(),
  draftTexts: () => Object.values(root.stores.drafts.getState().drafts).map(draft=>draft.text).filter(Boolean),
  pending: () => root.localWork!.status.getState().pending,
  key: () => root.stores.connection.getState().accountKey,
  ready: () => root.localWork!.restoring(),
  held: () => updateHeld(root),
  rows: (partition: PartitionId) => root.recordings!.list(partition),
  read: async (partition: PartitionId) => Promise.all((await readDisk(partition)).map(async record => {
    const value = record.value as {data?: Blob};
    if (!(value?.data instanceof Blob)) return record;
    const digest = await crypto.subtle.digest("SHA-256", await value.data.arrayBuffer());
    return { key: record.key, value: { ...value, data: { size: value.data.size, hash: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,"0")).join("") } } };
  })),
  sizes: () => root.partitions!.sizes(),
  seed: async (partition: PartitionId, id: string, transcript = false) => {
    const data = new Blob([new Uint8Array(generateWav(AUDIO_FIXTURES.note10s))], { type: "audio/wav" });
    await raw(partition).write([
      { put: `recording:index:${id}`, value: { id, state: transcript ? "transcript-ready" : "saved", mime: "audio/wav", durationMs: 10_000, bytes: data.size, savedThroughMs: 10_000, contentHash: "odysseus-audio", chunkCount: 1, createdAt: Date.parse(id === "aeolus" ? "2026-07-12T10:00:00" : "2026-07-12T09:00:00"), ...(transcript ? { transcript: "Tie Odysseus to the mast." } : {}) } },
      { put: `recording:chunk:${id}:00000000`, value: { index: 0, startMs: 0, endMs: 10_000, data } },
    ]);
  },
  refresh: () => { root.stores.connection.setState({}); },
  assign: (id: string) => outcome(root.recordings!.assign(id)),
  move: (from: PartitionId, to: PartitionId, keys: string[]) => outcome(root.partitions!.move(from, to, keys)),
  edit: async () => { await root.localWork!.restoring(); const drafts = root.stores.drafts.getState(); drafts.edit(drafts.fresh, null, { text: "Penelope keeps the loom order." }); await root.localWork!.snapshotNow(); },
  stage: () => { const d = root.stores.drafts.getState(); tracksFor(root, trackKey(null, d.fresh)).uploads.restore([{ path: "media/ithaca.gpx", name: "Ithaca approach", bytes: 100, mediaType: "application/gpx+xml" }]); },
  receipt: (partition: PartitionId) => raw(partition).put("recording:accepted:laertes", { accepted: true }),
  extra: (partition: PartitionId) => raw(partition).put("recording:orphan:ithaca", "orphan witness"),
  quota: () => { fault = failIndexedDbWrites({ next: true }); },
  restore: () => { fault?.restore(); fault = null; hold?.restore(); hold = null; },
  holdDraft: () => { hold = holdIndexedDbWrite(key => Array.isArray(key) && String(key[1]).includes("/draft/")); },
  release: () => hold?.release(),
  authorize: async () => { authorized = await root.localWorkFlow.loss(); },
  tryStale: () => { void root.localWorkFlow.signOut(authorized!, false).catch(() => {}); return root.localWorkFlow.state.getState().signingOut; },
  authExpire: () => root.authLock.expire("revoked"),
  clearFailure: () => { root.partitions!.prepareSignOut = () => async () => { throw new Error("Device storage refused deletion"); }; },
  compose: () => compose(),
  background: () => ({ settingsClosed, dictationCancelled, finalText: root.stores.voice.getState().finalText, partial: root.stores.voice.getState().partial }),
  live: (kind: "final" | "partial" | "draining") => root.stores.voice.setState({ mode: "dictate", finalText: kind === "partial" ? "" : "Odysseus approaches Ithaca.", partial: kind === "partial" ? "The harbour" : "", draining: kind === "draining", reviewText: "" }),
  pendingTranscript: async () => {
    const partition = `account:${root.stores.connection.getState().accountKey}` as PartitionId;
    hold = holdIndexedDbWrite(key => Array.isArray(key) && key[1] === "recording:index:sirens");
    pendingWrite = outcome(root.recordings!.saveTranscript(partition, "sirens", "Tie Odysseus to the mast."));
    await hold.started;
  },
  pendingInventory: async () => {
    const partition = `account:${root.stores.connection.getState().accountKey}` as PartitionId;
    hold = holdIndexedDbWrite(key => Array.isArray(key) && key[1] === "inventory:block");
    pendingWrite = outcome(root.partitions!.open(partition).put("inventory:block", "A native write delays the loss inventory."));
    await hold.started;
  },
  pendingDone: () => pendingWrite,
  dirty: () => { const d = root.stores.drafts.getState(); d.edit(d.fresh, null, { text: "Aeolus closes the bag." }); },
  snapshot: () => outcome(root.localWork!.snapshotNow()),
  holdWriter: async () => { const key = root.stores.connection.getState().accountKey!; staleKey = key; staleParts = createLocalPartitions({ name: "brain-ui-local", heldAccountKey: () => key }); const handle = staleParts.open(`account:${key}`); await handle.list(""); staleWrite = () => outcome(handle.put("stale:penelope", "Kept loom order")); },
  snapshots: () => snapshotCalls,
  staleWrite: () => staleWrite!(),
  staleNativeMove: async () => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) { return key.startsWith("brain-ui:account-write-fence:") ? null : get.call(this,key); };
    try {
      const keys = (await staleParts!.open("unassigned").list("")).map(record => record.key);
      return await outcome(staleParts!.move("unassigned", `account:${staleKey}`, keys));
    } finally { Storage.prototype.getItem = get; }
  },
  staleNative: async () => {
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) { return key.startsWith("brain-ui:account-write-fence:") ? null : get.call(this,key); };
    try { return await staleWrite!(); } finally { Storage.prototype.getItem = get; }
  },
  holdRecordingLock: () => new Promise<void>(resolve => { void navigator.locks.request("brain-ui:recording", async () => { lockHeld = true; resolve(); await new Promise<void>(release => { releaseLock = release; }); lockHeld = false; }); }),
  lockHeld: () => lockHeld,
  releaseRecordingLock: () => releaseLock?.(),
  captureUnassigned: async () => { root.stores.connection.setState({ accountKey: null }); await new Promise(resolve => setTimeout(resolve, 100)); await navigator.locks.request("brain-ui:recording", () => {}); await root.recordings!.start(); },
  captureActive: () => root.recordings!.active(),
  stopCapture: () => root.recordings!.stop("user"),
} });
window.addEventListener("pagehide", () => { root.dispose(); fault?.restore(); hold?.restore(); }, { once: true });
