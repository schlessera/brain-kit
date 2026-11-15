import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ChatPage, ConnectionGate, createBrainUiRoot } from "../../src/index.ts";

// The work context kept on this device (#1014), in the real app: the public
// ConnectionGate (whose probe carries the account key) around the public
// ChatPage, on a root whose prefix is the same after a reload.
const root = createBrainUiRoot({ storagePrefix: "odysseus-local", config: { appName: "Odysseus’s notebook", assistantName: "Brain" } });
const mount = document.getElementById("app");
if (!mount) throw new Error("Local work fixture mount is missing");
createRoot(mount).render(createElement(BrainUiProvider, { root, children: createElement(ConnectionGate, { children: createElement(ChatPage) }) }));

const draft = () => {
  const drafts = root.stores.drafts.getState();
  return drafts.drafts[drafts.idFor(root.stores.chat.getState().activeSessionId)];
};
const outcome = (p: Promise<unknown>) => p.then((value) => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, error: error.name }));

Object.assign(window, {
  __local: {
    connected: () => root.stores.connection.getState().wsStatus === "connected",
    accountKey: () => root.stores.connection.getState().accountKey,
    vpn: () => root.stores.connection.getState().vpnStatus,
    /** A probe that names another account, as a proxy's upstream user changing would. */
    holdKey: (key: string) => root.stores.connection.getState().setVpnStatus("connected", key),
    // A root that keeps nothing has nothing pending.
    status: () => root.localWork?.status.getState() ?? { failed: false, pending: false },
    activeSessionId: () => root.stores.chat.getState().activeSessionId,
    messages: () => {
      const chat = root.stores.chat.getState();
      return chat.activeSessionId ? chat.buffers[chat.activeSessionId]?.messages.length ?? 0 : 0;
    },
    text: () => draft()?.text ?? "",
    // Legacy inline images by their frame; image originals (#3155) by the stored record that names their bytes.
    images: () => [...(draft()?.attachments ?? []).map((a) => ({ data: a.attachment.data, mediaType: a.attachment.mediaType, name: a.name })),
      ...(draft()?.files ?? []).filter((f) => f.file.kind === "image").map((f) => ({ data: `${f.file.fileId}:${f.file.sha256}:${f.file.bytes}`, mediaType: f.file.mediaType, name: f.file.incomingName || f.file.name }))],
    reviewText: () => root.stores.voice.getState().reviewText,
    /** The review card's text, as a finished dictation leaves it (no microphone in CI). */
    review: (text: string) => root.stores.voice.getState().setReviewText(text),
    /** What the session list's row does. */
    resume: (sessionId: string) => {
      root.stores.chat.getState().clearMessages();
      root.stores.chat.getState().setActiveSession(sessionId);
      root.connection.send({ type: "session_resume", sessionId });
    },
    /** Type into the view's draft and snapshot at once, in one task: the snapshot is the write. */
    editAndSnapshot: (text: string) => {
      const drafts = root.stores.drafts.getState();
      const sessionId = root.stores.chat.getState().activeSessionId;
      drafts.edit(drafts.idFor(sessionId), sessionId, { text });
      return outcome(root.localWork!.snapshotNow());
    },
    restoring: () => root.localWork!.restoring(),
    /** Whether the host keeps drafts (#951), and the view's draft id. */
    draftsSupported: () => root.stores.drafts.getState().supported,
    draftId: () => root.stores.drafts.getState().idFor(root.stores.chat.getState().activeSessionId),
    /** One draft's reconciliation state, by id (#1214). */
    draft: (draftId: string) => {
      const d = root.stores.drafts.getState().drafts[draftId];
      return d ? { text: d.text, sessionId: d.sessionId, revision: d.host?.revision ?? null, uncertain: d.uncertain, bind: d.bind } : null;
    },
    texts: () => Object.values(root.stores.drafts.getState().drafts).map((d) => d.text),
    /** What the host keeps, read with this page's session cookie. */
    hostDrafts: async () => ((await (await fetch("/api/drafts")).json()) as { drafts: Array<{ draftId: string; sessionId: string | null; revision: number; preview: string }> }).drafts,
    clearHostDrafts: async () => {
      const { drafts } = (await (await fetch("/api/drafts")).json()) as { drafts: Array<{ draftId: string; revision: number }> };
      for (const d of drafts) await fetch(`/api/drafts/${encodeURIComponent(d.draftId)}`, { method: "DELETE", headers: { "if-match": String(d.revision) } });
    },
    snapshotNow: () => outcome(root.localWork ? root.localWork.snapshotNow() : Promise.resolve()),
    /** The partition module itself, past any UI. */
    read: (accountKey: string, key: string) => outcome(root.partitions!.open(`account:${accountKey}`).get(key)),
    list: (accountKey: string) => outcome(root.partitions!.open(`account:${accountKey}`).list("")),
    write: (accountKey: string, key: string) => outcome(root.partitions!.open(`account:${accountKey}`).put(key, { v: 1, text: "Polyphemus' cave" })),
    sizes: () => root.partitions!.sizes(),
    /**
     * The first message in view and its top's distance from the transcript's
     * top, measured on message-shell geometry and visual ordinal, independently
     * of the product's saved-anchor attribute. Arrival rows may wrap a shell.
     */
    firstVisible: () => {
      const column = document.querySelector<HTMLElement>("[data-reading-column]");
      const el = column?.closest<HTMLElement>(".overflow-y-auto");
      if (!column || !el) return null;
      const top = el.getBoundingClientRect().top;
      const rows = [...column.children].flatMap(node => {
        if (!(node instanceof HTMLElement)) return [];
        const shell = node.classList.contains("py-4") ? node : node.querySelector<HTMLElement>(":scope > .py-4");
        return shell ? [shell] : [];
      });
      for (const [i, node] of rows.entries()) {
        const box = node.getBoundingClientRect();
        if (box.bottom > top) return { anchor: String(i), offset: box.top - top, scrollTop: el.scrollTop };
      }
      return null;
    },
    scrollTo: (top: number) => {
      const el = document.querySelector<HTMLElement>("[data-reading-column]")?.closest<HTMLElement>(".overflow-y-auto");
      if (el) { el.scrollTop = top; el.dispatchEvent(new Event("scroll")); }
    },
  },
});
window.addEventListener("pagehide", () => root.dispose(), { once: true });
