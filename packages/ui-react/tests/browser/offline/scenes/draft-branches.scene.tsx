import { createRoot } from "react-dom/client";
import { BrainUiProvider } from "../../../../src/root-context.js";
import { ChatPage } from "../../../../src/components/chat/chat-page.js";
import { createBrainUiRoot } from "../../../../src/root.js";
import { createLocalWork } from "../../../../src/lib/local-work.js";
import { tracksFor, trackKey } from "../../../../src/lib/draft-tracks.js";
import { createLocalPartitions } from "../../../../src/lib/local-partitions.js";
import { defineScene } from "../define-scene.ts";
import { installFaultNetwork } from "../fault-network.ts";
import {
  failIndexedDbWrites,
  holdIndexedDbWrite,
} from "../indexeddb-faults.ts";
import kitCss from "../../../../../ui-kit/dist/styles.css?raw";
import appCss from "../../../../dist/styles.css?raw";

// Each openScene owns its origin/context; sibling pages share only its actual
// account/root IndexedDB. No host draft API or provider is available.
const previewFetch = window.fetch.bind(window);
const net = installFaultNetwork({
  routes: (url) =>
    url.pathname.endsWith("/sessions")
      ? Response.json({
          sessions: [
            {
              id: "ithaca",
              title: "The loom",
              createdAt: 1,
              lastActiveAt: 1,
              numTurns: 1,
              totalCostUsd: 0,
            },
          ],
        })
      : Response.json({}),
});
const root = createBrainUiRoot({ storage: null, request: net.request });
let ordinarySends = 0;
const resumes: string[] = [];
const nativeSend = root.connection.send.bind(root.connection);
root.connection.send = (message) => {
  if (message.type === "session_resume") {
    resumes.push(message.sessionId);
    return true;
  }
  if (message.type === "chat_message") {
    ordinarySends++;
    return true;
  }
  return nativeSend(message);
};
root.stores.connection.getState().setVpnStatus("connected", "odysseus");
root.stores.connection.setState({ wsStatus: "connected" });
root.stores.drafts.getState().setSupport(false);
root.stores.chat
  .getState()
  .setActiveSession(
    JSON.parse(localStorage.getItem("odysseus-branch-navigation") ?? '"ithaca"')
  );
const partitions = createLocalPartitions({
  name: "odysseus-branches",
  heldAccountKey: () => root.stores.connection.getState().accountKey,
});
const holdRestoring = sessionStorage.getItem("odysseus-hold-restore") === "1";
sessionStorage.removeItem("odysseus-hold-restore");
let readPrefix = "root:ithaca/draft/";
let readCount = 0;
let readDelayAt = 0;
let releaseRead = () => {};
let readGate = Promise.resolve();
let pauseSnapshot = false;
let snapshotWaiting = false;
let releaseSnapshot = () => {};
let snapshotGate = Promise.resolve();
const nativeLockRequest = navigator.locks.request.bind(navigator.locks);
navigator.locks.request = (async (...args: unknown[]) => {
  if (pauseSnapshot && String(args[0]).startsWith("brain-ui:work:")) {
    snapshotWaiting = true;
    await snapshotGate;
  }
  return (nativeLockRequest as Function)(...args);
}) as typeof navigator.locks.request;
const nativeOpen = partitions.open.bind(partitions);
partitions.open = (id) => {
  const handle = nativeOpen(id);
  return {
    ...handle,
    async list(prefix) {
      const rows = await handle.list(prefix);
      if (holdRestoring && prefix === "root:ithaca/") {
        readGate = new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        readCount++;
        await readGate;
      }
      return rows;
    },
    async get(key) {
      const value = await handle.get(key);
      if (readDelayAt && key.startsWith(readPrefix)) {
        readCount++;
        if (readCount === readDelayAt) await readGate;
      }
      return value;
    },
  };
};
root.partitions = partitions;
root.localWork = createLocalWork({
  stores: root.stores,
  partitions,
  scope: "root:ithaca",
  tracks: () => [],
  watchTracks: () => () => {},
  onAccountSwitch: () => {},
});
if (!holdRestoring) await root.localWork.restoring();
const style = document.createElement("style");
style.textContent = `${kitCss}\n${appCss}\nhtml,body,#scene{height:100%;margin:0}#scene{display:flex;flex-direction:column}`;
document.head.append(style);
const react = createRoot(document.getElementById("scene")!);
react.render(
  <BrainUiProvider root={root}>
    <ChatPage />
  </BrainUiProvider>
);
const field = () =>
  document.querySelector<HTMLTextAreaElement>("textarea[data-composer]")!;
const draft = () => {
  const s = root.stores.drafts.getState();
  return s.drafts[s.idFor(root.stores.chat.getState().activeSessionId)];
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function settled() {
  for (let i = 0; i < 100; i++) {
    if (
      field() &&
      !document
        .getAnimations()
        .some(
          (a) =>
            a.playState === "running" &&
            a.effect?.getComputedTiming().endTime !== Infinity
        )
    )
      return;
    await wait(20);
  }
  throw new Error("entrances did not settle");
}
let imageHeld = false;
let releaseImage = () => {};
let imageDone = false;
let snapshot: { done: boolean; error?: string } = { done: false };
let hold: ReturnType<typeof holdIndexedDbWrite> | null = null;
let fault: ReturnType<typeof failIndexedDbWrites> | null = null;
defineScene({
  draftContent(id: string) {
    const d = root.stores.drafts.getState().drafts[id];
    return d
      ? {
          text: d.text,
          attachments: d.attachments.map((a) => ({
            data: a.attachment.data,
            mediaType: a.attachment.mediaType,
            name: a.name,
            bytes: a.bytes,
          })),
        }
      : null;
  },
  orderDrafts(first: string, second: string) {
    const s = root.stores.drafts.getState();
    const rest = { ...s.drafts };
    delete rest[first];
    delete rest[second];
    root.stores.drafts.setState({
      drafts: {
        [first]: s.drafts[first]!,
        [second]: s.drafts[second]!,
        ...rest,
      },
    });
  },
  async previews() {
    const usable = async (url: string) => {
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        const response = await previewFetch(url);
        return response.ok && (await response.blob()).size > 0;
      } catch {
        return false;
      }
    };
    return {
      snapshot: await Promise.all(
        (
          root.stores.drafts.getState().sends["odysseus-send"]?.attachments ??
          []
        ).map((a) => usable(a.previewUrl))
      ),
      editable: await Promise.all(
        (draft()?.attachments ?? []).map((a) => usable(a.previewUrl))
      ),
    };
  },
  pauseSnapshot() {
    pauseSnapshot = true;
    snapshotWaiting = false;
    snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
  },
  snapshotWaiting: () => snapshotWaiting,
  releaseSnapshot() {
    pauseSnapshot = false;
    releaseSnapshot();
  },
  sendState() {
    const s = root.stores.drafts.getState();
    const send = s.sends["odysseus-send"];
    return {
      state: send?.state ?? null,
      waiting: Object.values(s.sends)
        .filter(
          (x) =>
            s.sendDraftId(x.requestId) === draft()!.draftId &&
            (x.state === "pending" || x.state === "unconfirmed")
        )
        .map((x) => x.state),
      snapshotImages: send?.attachments.map((a) => ({
        data: a.attachment.data,
        preview: a.previewUrl,
      })),
      editableImages: draft()!.attachments.map((a) => ({
        data: a.attachment.data,
        preview: a.previewUrl,
      })),
    };
  },
  acceptIn(session: string) {
    root.stores.drafts.getState().accepted("odysseus-send", session);
    root.stores.chat.getState().setActiveSession(session);
  },
  holdRestore() {
    sessionStorage.setItem("odysseus-hold-restore", "1");
  },
  async coldReady() {
    await settled();
  },
  async restored() {
    await root.localWork!.restoring();
    await wait(0);
  },
  startAdd(source: string) {
    readPrefix = "recording:accepted:odysseus-recording";
    readCount = 0;
    readDelayAt = 1;
    readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    snapshot = { done: false };
    void root
      .localWork!.addTranscript(
        "odysseus-recording",
        "Bring the oars.",
        source,
        null
      )
      .then(
        () => {
          snapshot = { done: true };
        },
        (e) => {
          snapshot = { done: true, error: e.message };
        }
      );
  },
  receipt() {
    return partitions
      .openAccount()
      .get("recording:accepted:odysseus-recording");
  },
  async ready(width: number, theme: string) {
    document.documentElement.dataset.theme = theme;
    document.body.style.width = `${width}px`;
    await settled();
    await root.localWork!.snapshotNow();
  },
  async edit(text: string, image = false, target?: string) {
    const data = text.startsWith("Telemachus")
      ? "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII="
      : "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const s = root.stores.drafts.getState();
    const id = target ?? s.idFor(root.stores.chat.getState().activeSessionId);
    s.edit(id, root.stores.chat.getState().activeSessionId, {
      text,
      ...(image
        ? {
            attachments: [
              {
                attachment: { mediaType: "image/png" as const, data },
                previewUrl: `data:image/png;base64,${data}`,
                name: "shroud.png",
                bytes: 68,
              },
            ],
          }
        : {}),
    });
    await wait(0);
    field().focus();
    field().setSelectionRange(3, 9);
  },
  blobPreviews() {
    const d = draft()!;
    root.stores.drafts.getState().edit(d.draftId, d.sessionId, {
      attachments: d.attachments.map((a) => ({
        ...a,
        previewUrl: URL.createObjectURL(
          new Blob(
            [Uint8Array.from(atob(a.attachment.data), (c) => c.charCodeAt(0))],
            { type: a.attachment.mediaType }
          )
        ),
      })),
    });
  },
  async startDelayedImage() {
    imageHeld = false;
    imageDone = false;
    const native = window.createImageBitmap.bind(window);
    const gate = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    window.createImageBitmap = (async (
      ...args: Parameters<typeof createImageBitmap>
    ) => {
      window.createImageBitmap = native;
      const bitmap = await (native as Function)(...args);
      imageHeld = true;
      await gate;
      return bitmap;
    }) as typeof createImageBitmap;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    canvas.getContext("2d")!.fillRect(0, 0, 64, 64);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), "image/png")
    );
    const files = new DataTransfer();
    files.items.add(new File([blob], "sail.png", { type: "image/png" }));
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"][accept="image/*"][multiple]'
    )!;
    input.files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  },
  imageHeld: () => imageHeld,
  releaseImage() {
    releaseImage();
    imageDone = true;
  },
  imageDone: () => imageDone,
  stageTrack() {
    const s = root.stores.drafts.getState();
    const queue = tracksFor(
      root,
      trackKey(
        root.stores.chat.getState().activeSessionId,
        s.originOf(draft()!.draftId)
      )
    ).uploads;
    queue.setOnline(false);
    return queue.add([
      new File(
        [
          '<gpx version="1.1"><trk><trkseg><trkpt lat="38" lon="20"/></trkseg></trk></gpx>',
        ],
        "ithaca.gpx",
        { type: "application/gpx+xml" }
      ),
    ]);
  },
  tracks(id: string) {
    const s = root.stores.drafts.getState();
    const d = s.drafts[id]!;
    return tracksFor(
      root,
      trackKey(d.sessionId, s.originOf(id))
    ).uploads.files.map((t) => t.file.name);
  },
  async save() {
    try {
      await root.localWork!.snapshotNow();
      return "ok";
    } catch (e) {
      return (e as Error).name;
    }
  },
  resumes() {
    return resumes;
  },
  review(text: string) {
    root.stores.voice.setState({ reviewText: text });
  },
  loss() {
    return root.localWorkFlow.loss();
  },
  stopAfterFork() {
    const off = root.stores.drafts.subscribe((s) => {
      if (Object.values(s.drafts).some((d) => d.deviceConflict)) {
        off();
        root.localWork!.dispose();
      }
    });
  },
  async contexts() {
    return partitions.openAccount().list("root:ithaca/context");
  },
  editUnconfirmed() {
    root.stores.drafts.getState().unconfirmed("disconnected");
    root.connection.drafts.edit("odysseus-send");
  },
  async rows() {
    return partitions.openAccount().list("root:ithaca/draft/");
  },
  view() {
    return {
      width: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
      sendDisabled:
        document
          .querySelector('[aria-label^="Send"]')
          ?.getAttribute("aria-disabled") === "true",
      sendCount: document.querySelectorAll('[aria-label^="Send"]').length,
      images: draft()?.attachments.map((a) => ({
        data: a.attachment.data,
        mediaType: a.attachment.mediaType,
        name: a.name,
        bytes: a.bytes,
      })),
      action: (() => {
        const r = document
          .querySelector("[data-device-conflict] button")
          ?.getBoundingClientRect();
        return r ? { width: r.width, height: r.height } : null;
      })(),
      id: draft()?.draftId,
      text: field().value,
      session: root.stores.chat.getState().activeSessionId,
      selection: [field().selectionStart, field().selectionEnd],
      focused: document.activeElement === field(),
      notice:
        document.querySelector("[data-device-conflict]")?.textContent ?? "",
      failed: root.localWork!.status.getState().failed,
      drafts: Object.values(root.stores.drafts.getState().drafts).map((d) => ({
        id: d.draftId,
        session: d.sessionId,
        text: d.text,
      })),
    };
  },
  async openOther() {
    await settled();
    const action = document.querySelector<HTMLButtonElement>(
      "[data-device-conflict] button"
    );
    if (!action) throw new Error("no other-version action");
    action.click();
    await wait(100);
  },
  async openStored(id: string) {
    await root.localWork!.openDeviceVersion(id);
    root.stores.chat
      .getState()
      .setActiveSession(
        root.stores.drafts.getState().drafts[id]?.sessionId ?? null
      );
    await wait(0);
  },
  async openDraft(id: string) {
    root.stores.chat.getState().setActiveSession(null);
    root.stores.drafts.getState().openUnbound(id);
    await wait(100);
  },
  async hold() {
    hold = holdIndexedDbWrite(
      (key) =>
        Array.isArray(key) && String(key[1]).startsWith("root:ithaca/draft/")
    );
  },
  async startSave() {
    snapshot = { done: false };
    void root.localWork!.snapshotNow().then(
      () => {
        snapshot = { done: true };
      },
      (e) => {
        snapshot = { done: true, error: e.name };
      }
    );
  },
  held: () => !!hold,
  async waitHeld() {
    await hold!.started;
  },
  release() {
    hold?.restore();
    hold = null;
  },
  snapshot: () => snapshot,
  quota() {
    fault = failIndexedDbWrites({ afterBytes: 0 });
  },
  recoverStorage() {
    fault?.restore();
    fault = null;
  },
  async empty() {
    const s = root.stores.drafts.getState();
    s.edit(s.idFor("ithaca"), "ithaca", { text: "", attachments: [] });
    return "empty";
  },
  async ordinarySend() {
    await settled();
    const button = document.querySelector<HTMLElement>(
      '[role="button"][aria-label^="Send"]'
    );
    if (!button) throw new Error("the real composer has no Send control");
    button.click();
    await wait(0);
    return ordinarySends;
  },
  openInMemory(id: string) {
    root.stores.drafts.getState().openDeviceVersion(id);
    root.stores.chat
      .getState()
      .setActiveSession(
        root.stores.drafts.getState().drafts[id]?.sessionId ?? null
      );
  },
  delayedOpen() {
    const id = draft()!.deviceConflict!.otherId;
    readCount = 0;
    readDelayAt = 1;
    readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    snapshot = { done: false };
    void root.localWork!.openDeviceVersion(id).then(() => {
      root.stores.chat
        .getState()
        .setActiveSession(
          root.stores.drafts.getState().drafts[id]?.sessionId ?? null
        );
      snapshot = { done: true };
    });
  },
  async doubleOpen() {
    const id = draft()!.deviceConflict!.otherId;
    readCount = 0;
    readDelayAt = 2;
    readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const open = async () => {
      await root.localWork!.openDeviceVersion(id);
      root.stores.chat
        .getState()
        .setActiveSession(
          root.stores.drafts.getState().drafts[id]?.sessionId ?? null
        );
    };
    const first = open();
    void open();
    await first;
    await wait(0);
  },
  releaseRead() {
    releaseRead();
    readDelayAt = 0;
  },
  reads: () => readCount,
  acceptNew() {
    root.stores.drafts.getState().accepted("odysseus-send", "pylos");
    root.stores.chat.getState().setActiveSession("pylos");
  },
  async navigate(session: string | null) {
    localStorage.setItem("odysseus-branch-navigation", JSON.stringify(session));
    root.stores.chat.getState().setActiveSession(session);
    await wait(0);
  },
  ackOriginal() {
    const s = root.stores.drafts.getState();
    const id = draft()!.deviceConflict!.otherId;
    s.saved(
      id,
      {
        revision: 1,
        edit: s.drafts[id]!.edit,
        sessionId: "ithaca",
        attachmentIds: [],
        updatedAt: 3,
      },
      new Map()
    );
  },
  removeOriginal(kind: string) {
    const id = draft()!.draftId;
    if (kind === "gone") root.stores.drafts.getState().hostGone(id);
    else root.stores.drafts.getState().removed(id);
    return root.stores.drafts.getState().resolveId(id);
  },
  rotate() {
    const id = draft()!.draftId;
    root.stores.drafts.getState().hostGone(id);
    return root.stores.drafts.getState().resolveId(id);
  },
  hostConflict() {
    const d = draft()!;
    root.stores.drafts.getState().conflictWith(
      d.draftId,
      {
        draftId: d.draftId,
        sessionId: null,
        revision: 2,
        text: "Athena keeps the host version",
        attachments: [],
        updatedAt: 2,
      },
      true
    );
  },
  async compare() {
    await settled();
    const button = document.querySelector<HTMLButtonElement>(
      "[data-draft-compare]"
    );
    if (!button) return false;
    button.click();
    await wait(0);
    return document.querySelector("[data-compare-drafts]")?.textContent;
  },
  settleSend(outcome: string) {
    if (outcome === "accept")
      root.stores.drafts.getState().accepted("odysseus-send", "ithaca");
    else root.stores.drafts.getState().refused("odysseus-send");
  },
  async send(pending = false) {
    const s = root.stores.drafts.getState();
    const d = draft()!;
    s.beginSend(
      {
        requestId: "odysseus-send",
        draftId: d.draftId,
        sessionId: root.stores.chat.getState().activeSessionId,
        text: d.text,
        attachments: [...d.attachments],
        message: {
          type: "chat_message",
          requestId: "odysseus-send",
          sessionId: "ithaca",
          text: d.text,
        },
      },
      d.text
    );
    if (!pending) s.accepted("odysseus-send", "ithaca");
  },
  async clearAccount() {
    const clear = partitions.prepareSignOut("account:odysseus");
    await clear();
  },
  async access(account: string) {
    try {
      await partitions.open(`account:${account}`).list("");
      return "read";
    } catch (e) {
      return (e as Error).name;
    }
  },
  account(account: string) {
    root.stores.connection.getState().setVpnStatus("connected", account);
  },
});
window.addEventListener("pagehide", () => root.dispose(), { once: true });
