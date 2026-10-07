import { watchMicrophone } from "../browser/offline/fake-microphone.ts";
import { trackKey, tracksFor } from "../../src/lib/draft-tracks.ts";
import { updateHeld } from "../../src/lib/update-holds.ts";
import { createElement, useEffect } from "react";
import { useRootStore } from "../../src/root-context.tsx";
import { createRoot } from "react-dom/client";
import { BrainUiProvider, ChatPage, ConnectionGate, createBrainUiRoot } from "../../src/index.ts";

// The work context kept on this device (#1014), in the real app: the public
// ConnectionGate (whose probe carries the account key) around the public
// ChatPage, on a root whose prefix is the same after a reload.
const root = createBrainUiRoot({ storagePrefix: "odysseus-auth-expiry", localCapture:true, config: { appName: "Odysseus’s notebook", assistantName: "Brain" } });
const microphone=watchMicrophone();
function SessionTitle() {
  const sessions = useRootStore("sessions", (s) => s.sessions);
  useEffect(() => { void root.stores.sessions.getState().refresh(); }, []);
  return createElement("p", null, sessions[0]?.title);
}
const mount = document.getElementById("app");
if (!mount) throw new Error("Local work fixture mount is missing");
createRoot(mount).render(createElement(BrainUiProvider, { root, children: createElement(ConnectionGate, { children: createElement("div", {style:{display:"flex",flexDirection:"column",height:"100%"}},
  createElement("button", {id:"fixture-record", onClick:()=>void root.recordings!.start()}, "Start local recording"),
  createElement(SessionTitle), createElement(ChatPage)) }) }));

const draft = () => {
  const drafts = root.stores.drafts.getState();
  return drafts.drafts[drafts.idFor(root.stores.chat.getState().activeSessionId)];
};
const outcome = (p: Promise<unknown>) => p.then((value) => ({ ok: true as const, value }), (error: Error) => ({ ok: false as const, error: error.name }));

Object.assign(window, {
  __local: {
    phase:()=>root.authLock.state.getState().phase,
    held:()=>updateHeld(root),
    recording:()=>root.recordings!.list(root.stores.connection.getState().accountKey ? `account:${root.stores.connection.getState().accountKey}` : "unassigned"),
    ended:()=>microphone.streams.flatMap((s)=>s.getTracks().map((t)=>t.readyState === "ended")),
    tracks:()=>{
      const drafts=root.stores.drafts.getState(); const session=root.stores.chat.getState().activeSessionId;
      return tracksFor(root,trackKey(session,drafts.originOf(drafts.idFor(session)))).uploads.files.filter(f=>f.state === "ready").map(f=>f.meta);
    },
    savedThrough:()=>root.authLock.state.getState().savedThroughMs,
    chunkEnds:async()=>{
      const key=root.stores.connection.getState().accountKey!;
      const rows=await root.partitions!.open(`account:${key}`).list("recording:chunk:");
      return rows.map(r=>(r.value as {endMs:number}).endMs);
    },
    readAudio:(key:string,id:string)=>outcome(root.recordings!.playback(`account:${key}`,id)),
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
    images: () => (draft()?.attachments ?? []).map((a) => ({ data: a.attachment.data, mediaType: a.attachment.mediaType, name: a.name })),
    allImages: () => Object.values(root.stores.drafts.getState().drafts).flatMap((d) => d.attachments.map((a) => ({ data: a.attachment.data, name: a.name }))),
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
    snapshotNow: () => outcome(root.localWork ? root.localWork.snapshotNow() : Promise.resolve()),
    /** The partition module itself, past any UI. */
    read: (accountKey: string, key: string) => outcome(root.partitions!.open(`account:${accountKey}`).get(key)),
    list: (accountKey: string) => outcome(root.partitions!.open(`account:${accountKey}`).list("")),
    write: (accountKey: string, key: string) => outcome(root.partitions!.open(`account:${accountKey}`).put(key, { v: 1, text: "Polyphemus' cave" })),
    sizes: () => root.partitions!.sizes(),
    /**
     * The first message in view and its top's distance from the transcript's
     * top, measured on the transcript's own rows (each message is one row of
     * the reading column), not on anything the code under test adds.
     */
    firstVisible: () => {
      const column = document.querySelector<HTMLElement>("[data-reading-column]");
      const el = column?.closest<HTMLElement>(".overflow-y-auto");
      if (!column || !el) return null;
      const top = el.getBoundingClientRect().top;
      const rows = [...column.children].filter((n): n is HTMLElement => n instanceof HTMLElement && n.classList.contains("py-4"));
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
