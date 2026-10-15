import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useEffect, useSyncExternalStore } from "react";
import { createBrainUiRoot } from "../../../src/root.js";
import { BrainUiProvider } from "../../../src/root-context.js";
import { useShareIntake } from "../../../src/hooks/use-share-intake.js";
import { getShareStore } from "../../../../ui-sdk/src/client/share-store.js";
import { handleShareTargetRequest } from "../../../../ui-sdk/src/client/share-target-handler.js";
import { PasskeyTab } from "../../../src/components/settings/passkey-tab.js";
import { SHARE_STASH_TTL_MS } from "@schlessera/brain-ui-sdk/protocol";

const account = new URL(location.href).searchParams.get("account") ?? "odysseus-ithaca";
if (new URL(location.href).searchParams.has("copyFailure")) {
  const descriptor = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put")!;
  const put = IDBObjectStore.prototype.put;
  Object.defineProperty(IDBObjectStore.prototype, "put", { ...descriptor, value(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (Array.isArray(key) && String(key[1]).startsWith("share:review:")) throw new DOMException("Account copy quota fault", "QuotaExceededError");
    return put.call(this, value, key);
  } });
  window.addEventListener("pagehide", () => Object.defineProperty(IDBObjectStore.prototype, "put", descriptor));
}
const ui = createBrainUiRoot({ storage: localStorage, storagePrefix: "odysseus-share-proof", request: (url, init) => fetch(url, init) });
ui.stores.connection.getState().setVpnStatus("connected", account);
// This fixture leaves transport disconnected until the test explicitly resumes it.
// The offline container has no external network interface. Only the connectivity
// flag is controlled; storage, locks, File bytes and loopback HTTP remain native.
const onlineDescriptor = Object.getOwnPropertyDescriptor(navigator, "onLine");
let online = false;
Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
window.addEventListener("pagehide", () => {
  if (onlineDescriptor) Object.defineProperty(navigator, "onLine", onlineDescriptor);
  else delete (navigator as { onLine?: boolean }).onLine;
});
let intake: ReturnType<typeof useShareIntake> | undefined;
function Review() {
  const driver = useShareIntake();
  useEffect(() => { intake = driver; return () => { if (intake === driver) intake = undefined; }; }, [driver]);
  return <main data-review>Share review<PasskeyTab active={false} /></main>;
}
function Gate() {
  const phase = useSyncExternalStore(ui.authLock.state.subscribe, () => ui.authLock.state.getState().phase);
  return phase === "locked" ? <main>Locked</main> : <Review />;
}
let renderer = createRoot(document.getElementById("app")!);
let secondRenderer: ReturnType<typeof createRoot> | undefined;
flushSync(() => renderer.render(<BrainUiProvider root={ui}><Gate /></BrainUiProvider>));
const fixture = {
  async stash() {
    const form = new FormData();
    form.set("text", "Penelope keeps the original loom plan.");
    form.set("files", new File([new Uint8Array([0, 1, 2, 255, 17])], "loom.pdf", { type: "application/pdf" }));
    const response = await handleShareTargetRequest(new Request(`${location.origin}/share-target`, { method: "POST", body: form }));
    return response.headers.get("Location")!;
  },
  async inventory() {
    const source = await getShareStore().list();
    const retained = await ui.partitions!.openAccount().list("share:review:");
    const originals = [...source, ...retained.map(row => (row.value as { record: typeof source[number] }).record)];
    return Promise.all(originals.map(async row => ({ id: row.id, text: row.text, bytes: Array.from(new Uint8Array(await row.files[0]!.arrayBuffer())) })));
  },
  queue: () => ui.stores.share.getState().queue.map(row => row.id),
  chats: () => ui.stores.chat.getState().draft?.messages.length ?? 0,
  loss: () => ui.localWorkFlow.loss(),
  status: () => ({ online: navigator.onLine, share: { busy: ui.stores.share.getState().busy, phase: ui.stores.share.getState().phase, error: ui.stores.share.getState().error }, connection: ui.stores.connection.getState().wsStatus }),
  confirm: () => intake!.confirm(ui.stores.share.getState().queue[0]!),
  confirmAll: async () => { for (const record of ui.stores.share.getState().queue) await intake!.confirm(record); },
  dismiss: () => intake!.dismiss(ui.stores.share.getState().queue[0]!),
  async expire() {
    await ui.localWork!.snapshotNow();
    await ui.authLock.expire("expired");
    ui.authLock.dropContext();
  },
  restore: () => ui.authLock.signedIn(account),
  resume: () => { online = true; ui.stores.connection.getState().setWsStatus("connected"); window.dispatchEvent(new Event("online")); },
  clear: async () => ui.localWorkFlow.signOut(await ui.localWorkFlow.loss(), false, () => false),
  cleared: async () => ({ originals: (await getShareStore().list()).length, account: await ui.partitions!.isSignOutCleared(`account:${account}`) }),
  unmount: () => flushSync(() => renderer.unmount()),
  mountSecond: () => {
    const host = document.createElement("div"); document.body.append(host);
    secondRenderer = createRoot(host);
    flushSync(() => secondRenderer!.render(<BrainUiProvider root={ui}><Gate /></BrainUiProvider>));
  },
  remount: () => {
    renderer = createRoot(document.getElementById("app")!);
    flushSync(() => renderer.render(<BrainUiProvider root={ui}><Gate /></BrainUiProvider>));
  },
  async expireRecord() {
    const partition = ui.partitions!.openAccount();
    const rows = await partition.list("share:review:");
    const row = rows[0]!; const review = row.value as { record: { receivedAt: number } };
    review.record.receivedAt = Date.now() - SHARE_STASH_TTL_MS - 1;
    await partition.put(row.key, review);
  },
};
Object.assign(window, { shareProof: fixture });
