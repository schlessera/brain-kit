import { createStore } from "zustand/vanilla";
import type { BrainUiRoot } from "../root.js";
import { accountPartition } from "./local-partitions.js";
import { hasContent } from "../stores/draft-state.js";
import { disposeTracks, stagedTrackViews } from "./draft-tracks.js";
import { registerUpdateHold } from "./update-holds.js";

export interface SignOutLoss {
  account: string | null;
  epoch: number;
  recordings: number;
  bytes: number;
  transcripts: number;
  accepted: number;
  drafts: number;
  tracks: number;
  review: boolean;
  unassigned: number;
  unknown: boolean;
  otherTabs: boolean;
  otherUnknown: boolean;
}

/** Internal per-root workflow; a sign-in event, never a connectivity probe,
 * requests association. Session storage carries that event through reload. */
export function createLocalWorkFlow(root: BrainUiRoot, prefix: string) {
  const marker = `${prefix}:associate-after-sign-in`;
  const noticeKey = `${prefix}:sign-out-notice`;
  const read = (key: string) => { try { return sessionStorage.getItem(key); } catch { return null; } };
  const write = (key: string, value: string | null) => {
    try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); return true; } catch { return false; }
  };
  const state = createStore(() => ({ association: 0, associationNotice: "", signingOut: false, signingIn: false, signInWarm: false, reloadingAfterSignIn: false, notice: read(noticeKey) ?? "" }));
  let pendingSignIn = false;
  let disposed = false;
  const gates = new Set<object>();
  const signIns = new Set<object>();
  const presenceId = crypto.randomUUID();
  const presencePrefix = (key: string) => `brain-ui:account-presence:${encodeURIComponent(key)}:`;
  let presenceKey: string | null = null;
  let lastKey: string | null = null;
  let cancelPresence = () => {};
  function syncPresence() {
    const account = root.stores.connection.getState().accountKey;
    if (account) lastKey = account;
    const key = account ?? (root.authLock.state.getState().phase === "saving" ? lastKey : null);
    if (presenceKey === key) return;
    cancelPresence(); presenceKey = key;
    if (!key || typeof navigator === "undefined" || !navigator.locks) { cancelPresence = () => {}; return; }
    const controller = new AbortController();
    let release = () => {};
    let live = true;
    cancelPresence = () => { live = false; controller.abort(); release(); };
    // Unique names avoid blocking work. Native query sees held and pending
    // roots, including a background page whose draft debounce has not fired.
    void navigator.locks.request(`${presencePrefix(key)}${presenceId}`, { signal: controller.signal }, async () => {
      if (!live) return;
      await new Promise<void>(resolve => { release = resolve; });
    }).catch(() => {});
  }
  const unwatchPresence = [root.stores.connection.subscribe(syncPresence), root.authLock.state.subscribe(syncPresence)];
  syncPresence();
  type PeerWork = { drafts: string[]; tracks: number; review: boolean };
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("brain-ui:local-work-inventory");
  const inquiries = new Map<string, { account: string; peers: Set<string>; values: Map<string, PeerWork>; finish(): void }>();
  if (channel) channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data as { kind?: string; request?: string; account?: string; peers?: string[]; owner?: string; work?: PeerWork } | null;
    if (!message || disposed || typeof message.request !== "string") return;
    if (message.kind === "ask" && message.account === presenceKey && Array.isArray(message.peers) && message.peers.includes(presenceId)) {
      channel.postMessage({ kind: "answer", request: message.request, account: presenceKey, owner: presenceId, work: {
        drafts: Object.values(root.stores.drafts.getState().drafts).filter(hasContent).map(draft => draft.draftId),
        tracks: stagedTrackViews(root).reduce((count, view) => count + view.count, 0),
        review: [root.stores.voice.getState().reviewText, root.stores.voice.getState().finalText, root.stores.voice.getState().partial].some(text => !!text.trim()),
      } });
      return;
    }
    const inquiry = inquiries.get(message.request);
    const work = message.work;
    if (message.kind !== "answer" || !inquiry || message.account !== inquiry.account || !message.owner || !inquiry.peers.has(message.owner) || !work) return;
    if (!Array.isArray(work.drafts) || !work.drafts.every(id => typeof id === "string") || !Number.isSafeInteger(work.tracks) || work.tracks < 0 || typeof work.review !== "boolean") return;
    inquiry.values.set(message.owner, work);
    if (inquiry.values.size === inquiry.peers.size) inquiry.finish();
  };
  function peerInventory(account: string, peers: string[]): Promise<{ values: PeerWork[]; complete: boolean }> {
    if (!peers.length) return Promise.resolve({ values: [], complete: true });
    if (!channel) return Promise.resolve({ values: [], complete: false });
    return new Promise(resolve => {
      const request = crypto.randomUUID();
      const inquiry = { account, peers: new Set(peers), values: new Map<string, PeerWork>(), finish() {
        clearTimeout(timer); inquiries.delete(request);
        resolve({ values: [...inquiry.values.values()], complete: inquiry.values.size === inquiry.peers.size });
      } };
      // An unresponsive/frozen page remains an explicit unknown in the warning.
      // Counts and opaque draft IDs are the only peer data; no work content.
      const timer = setTimeout(() => inquiry.finish(), 200);
      inquiries.set(request, inquiry);
      try { channel.postMessage({ kind: "ask", request, account, peers }); } catch { inquiry.finish(); }
    });
  }
  const releaseHold = registerUpdateHold(root, { busy: () => state.getState().signingOut || state.getState().signingIn, subscribe: fn => state.subscribe(fn) });
  let signingOut: Promise<void> | null = null;
  const unwatchSignOut = root.partitions?.subscribeSignOut(id => {
    if (id === "unassigned") return;
    if (state.getState().signingOut) return;
    state.setState({ notice: "This account is being signed out in another tab. Check that tab for the deletion result." });
    void root.authLock.expire("signed out", true);
  });
  return {
    state,
    beginSignIn(warm: boolean) {
      const owner = {}; signIns.add(owner); state.setState({ signingIn: true, signInWarm: warm });
      return () => { signIns.delete(owner); if (!signIns.size && !state.getState().reloadingAfterSignIn) state.setState({ signingIn: false, signInWarm: false }); };
    },
    reloadAfterSignIn() { state.setState({ reloadingAfterSignIn: true }); window.location.reload(); },
    attachGate() { const owner = {}; gates.add(owner); return () => { gates.delete(owner); }; },
    navigationFor(signal: AbortSignal) {
      const owners = [...gates];
      return () => !disposed && (!signal.aborted || owners.some(owner => gates.has(owner)));
    },
    dispose() { disposed = true; gates.clear(); signIns.clear(); for (const off of unwatchPresence) off(); cancelPresence(); for (const inquiry of [...inquiries.values()]) inquiry.finish(); channel?.close(); unwatchSignOut?.(); releaseHold(); },
    associated(count: number) { if (count) state.setState({ associationNotice: `${count} recordings added to your account.` }); },
    signedIn() { state.setState({ notice: "", associationNotice: "" }); write(noticeKey, null); pendingSignIn = true; write(marker, "yes"); state.setState(s => ({ association: s.association + 1 })); },
    hasSignIn() { return pendingSignIn || read(marker) === "yes"; },
    consumeSignIn() {
      const pending = pendingSignIn || read(marker) === "yes";
      pendingSignIn = false; write(marker, null);
      return pending;
    },
    async loss(): Promise<SignOutLoss> {
      const account = root.stores.connection.getState().accountKey;
      const epoch = root.authLock.epoch();
      const result: SignOutLoss = { account, epoch, recordings: 0, bytes: 0, transcripts: 0, accepted: 0, drafts: 0, tracks: stagedTrackViews(root).reduce((n, v) => n + v.count, 0), review: [root.stores.voice.getState().reviewText, root.stores.voice.getState().finalText, root.stores.voice.getState().partial].some(text => !!text.trim()), unassigned: 0, unknown: false, otherTabs: false, otherUnknown: false };
      const ids = new Set(Object.values(root.stores.drafts.getState().drafts).filter(hasContent).map(d => d.draftId));
      if (root.partitions) {
        try { result.unassigned = (await root.partitions.open("unassigned").list("recording:index:")).length; }
        catch { result.unknown = true; }
        try {
          if (account) {
            const records = await root.partitions.open(accountPartition(account)).list("");
            for (const { key, value } of records) {
              const row = value as { state?: string; bytes?: number; transcript?: string; draftId?: string; text?: string; attachments?: unknown[]; reviewText?: string };
              if (key.startsWith("recording:index:")) {
                if (row.state === "accepted" || records.some(r => r.key === `recording:accepted:${key.slice("recording:index:".length)}`)) result.accepted++;
                else { result.recordings++; if (row.transcript !== undefined) result.transcripts++; result.bytes += typeof row.bytes === "number" ? row.bytes : 0; }
              }
              if (key.includes("/draft/") && row.draftId && (row.text?.trim() || row.attachments?.length)) ids.add(row.draftId);
              if (key.endsWith("/context") && row.reviewText?.trim()) result.review = true;
            }
          }
        } catch {
          const cleared = account ? await root.partitions.isSignOutCleared(accountPartition(account)).catch(() => false) : false;
          result.unknown ||= !cleared;
        }
      }
      if (account && root.partitions) {
        try {
          const locks = await navigator.locks.query();
          const peers = [...new Set([...(locks.held ?? []), ...(locks.pending ?? [])].flatMap(lock => lock.name?.startsWith(presencePrefix(account)) && lock.name !== `${presencePrefix(account)}${presenceId}` ? [lock.name.slice(presencePrefix(account).length)] : []))];
          const inventory = await peerInventory(account, peers);
          for (const peer of inventory.values) {
            for (const id of peer.drafts) ids.add(id);
            result.tracks += peer.tracks; result.review ||= peer.review;
            if (peer.drafts.length || peer.tracks || peer.review) result.otherTabs = true;
          }
          result.otherUnknown = !inventory.complete;
          result.otherTabs ||= result.otherUnknown;
        } catch { result.otherTabs = true; result.otherUnknown = true; }
      }
      if (root.stores.connection.getState().accountKey !== account || root.authLock.epoch() !== epoch) throw new Error("Sign-in changed. Sign in again before signing out.");
      result.drafts = ids.size;
      return result;
    },
    signOut(loss: SignOutLoss, alsoUnassigned: boolean, canNavigate: () => boolean = () => !disposed): Promise<void> {
      if (signingOut) return signingOut;
      // A stale dialog must never authorize deletion of a new account.
      if (root.stores.connection.getState().accountKey !== loss.account || root.authLock.epoch() !== loss.epoch) return Promise.reject(new Error("Sign-in changed. Sign in again before signing out."));
      state.setState({ signingOut: true });
      signingOut = (async () => {
        let failed = false;
        try {
          const clearAccount = loss.account ? root.partitions?.prepareSignOut(accountPartition(loss.account)) : undefined;
          await root.localWork?.quiesce();
          if (loss.account) {
            if (root.recordings) await root.recordings.clearForSignOut(accountPartition(loss.account), alsoUnassigned, clearAccount);
            else await clearAccount?.();
          }
        } catch { failed = true; }
        // Clearing failure is reported after sign-out, never a veto on logout.
        try { await root.api.logout(); } catch { failed = true; }
        try { await root.answers.logout(); } catch { failed = true; }
        disposeTracks(root); // Remove guardLeaving before the authorized reload.
        let count: number | null = null;
        try { count = root.partitions ? (await root.partitions.open("unassigned").list("recording:index:")).length : 0; } catch { failed = true; }
        const notice = [count ? `${count} recordings not linked to any account are still on this device.` : "", failed ? "Sign-out was attempted, but local work or the server session could not be completely cleared. Local work may still be on this device." : ""].filter(Boolean).join(" ");
        state.setState({ notice });
        if (!canNavigate()) return;
        if (!write(noticeKey, notice) && notice) window.alert(notice);
        window.location.reload();
      })();
      return signingOut;
    },
  };
}
