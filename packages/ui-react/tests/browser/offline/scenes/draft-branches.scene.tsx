import { createRoot } from "react-dom/client";
import { BrainUiProvider } from "../../../../src/root-context.js";
import { ChatPage } from "../../../../src/components/chat/chat-page.js";
import { createBrainUiRoot } from "../../../../src/root.js";
import { createLocalWork } from "../../../../src/lib/local-work.js";
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
root.partitions = partitions;
root.localWork = createLocalWork({
  stores: root.stores,
  partitions,
  scope: "root:ithaca",
  tracks: () => [],
  watchTracks: () => () => {},
  onAccountSwitch: () => {},
});
await root.localWork.restoring();
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
let snapshot: { done: boolean; error?: string } = { done: false };
let hold: ReturnType<typeof holdIndexedDbWrite> | null = null;
let fault: ReturnType<typeof failIndexedDbWrites> | null = null;
defineScene({
  async ready(width: number, theme: string) {
    document.documentElement.dataset.theme = theme;
    document.body.style.width = `${width}px`;
    await settled();
    await root.localWork!.snapshotNow();
  },
  async edit(text: string, image = false) {
    const data = text.startsWith("Telemachus")
      ? "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII="
      : "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const s = root.stores.drafts.getState();
    const id = s.idFor(root.stores.chat.getState().activeSessionId);
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
  async save() {
    try {
      await root.localWork!.snapshotNow();
      return "ok";
    } catch (e) {
      return (e as Error).name;
    }
  },
  async rows() {
    return partitions.openAccount().list("root:ithaca/draft/");
  },
  view() {
    return {
      width: innerWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
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
  async navigate(session: string | null) {
    localStorage.setItem("odysseus-branch-navigation", JSON.stringify(session));
    root.stores.chat.getState().setActiveSession(session);
    await wait(0);
  },
  rotate() {
    root.stores.drafts.getState().hostGone(draft()!.draftId);
  },
  hostConflict() {
    const d = draft()!;
    root.stores.drafts
      .getState()
      .conflictWith(
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
    else root.stores.drafts.getState().sendFailed("odysseus-send");
  },
  async send(pending = false) {
    const s = root.stores.drafts.getState();
    const d = draft()!;
    s.beginSend(
      {
        requestId: "odysseus-send",
        draftId: d.draftId,
        sessionId: "ithaca",
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
