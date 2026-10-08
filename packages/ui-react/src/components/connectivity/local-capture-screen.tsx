import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { Button } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import type { RecordingStore, Recording } from "../../lib/recordings.js";
import { useLocalCapture } from "../../voice/use-local-capture.js";
import { LocalRecordingSheet } from "../voice/local-recording-sheet.js";
import { RecordingItem } from "../voice/recordings-tray.js";

export const LOCAL_CAPTURE_UNSUPPORTED = "This browser can't save recordings on the device. You can type a note and send it when you're back online.";
const size = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Shell-only capture. Account content is never opened, even after the probe recovers. */
export function LocalCaptureScreen({ reachable, onContinue }: {
  reachable: boolean;
  onContinue: () => void;
}) {
  const root = useBrainUiRoot();
  // The root owns this account-free store, including microphone disposal.
  return root.unassignedRecordings ? <LocalCaptureArea store={root.unassignedRecordings} reachable={reachable} onContinue={onContinue} /> : null;
}

function LocalCaptureArea({ store, reachable, onContinue }: {
  store: RecordingStore; reachable: boolean; onContinue: () => void;
}) {
  const root = useBrainUiRoot();
  const signOutNotice = useStore(root.localWorkFlow.state, s => s.notice);
  const capture = useLocalCapture({ store, allowLocked: true });
  const phase = useRootStore("voice", s => s.local);
  const denied = useRootStore("voice", s => s.localNotice === "denied");
  const error = useRootStore("voice", s => s.error);
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<Recording[]>([]);
  const [lockedBytes, setLockedBytes] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [removed, setRemoved] = useState("");
  const [leaving, setLeaving] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const record = useRef<HTMLDivElement>(null);
  const focusRecord = () => record.current?.querySelector<HTMLElement>('[role="button"]')?.focus({ preventScroll: true });
  useEffect(() => {
    heading.current?.focus();
    let live = true;
    let serial = 0;
    let recovered = false;
    let recovering = false;
    setReady(false);
    setRows([]);
    const refresh = async () => {
      if (!live || !recovered) return;
      const generation = ++serial;
      const [inventory, sizes] = await Promise.all([store.list("unassigned"), root.partitions!.sizes("recording:chunk:")]);
      if (!live || generation !== serial) return;
      setRows(inventory.filter(row => row.state !== "recording").sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)));
      setLockedBytes(sizes.filter(s => s.partition !== "unassigned").reduce((n, s) => n + s.bytes, 0));
    };
    const update = () => { void refresh().catch(() => { if (live) setNotice("Couldn't read recordings on this device. Saved recordings are kept."); }); };
    const unwatch = store.subscribe(update);
    const unwatchRoot = root.recordings?.subscribe(update);
    const events = store.onEvent(event => { if (live && event.message) setNotice(event.message); });
    const recover = async () => {
      if (!live || recovered || recovering) return;
      recovering = true;
      try {
        const result = await store.recover("unassigned");
        if (live) { recovered = true; setRemoved(result.removedMessage ?? ""); setReady(true); update(); }
      } catch { if (live) setNotice("Couldn't read recordings on this device. Saved recordings are kept."); }
      finally { recovering = false; }
    };
    void recover();
    const retry = setInterval(() => { if (recovered) update(); else void recover(); }, 3000);
    const voice = root.stores.voice.subscribe((state, previous) => {
      if (state.local === "idle" && previous.local !== "idle" && area.current?.querySelector("[data-local-recording-sheet]")?.contains(document.activeElement)) focusRecord();
    });
    return () => { live = false; clearInterval(retry); unwatch(); unwatchRoot?.(); events(); voice(); };
  }, [root, store]);
  useEffect(() => {
    if (phase === "recording") area.current?.querySelector<HTMLElement>('[aria-label="Stop and save"]')?.focus({ preventScroll: true });
  }, [phase]);
  const stop = async () => { await capture.stop(); focusRecord(); };
  const discard = async () => {
    try {
      const active = capture.recording();
      await stop();
      if (!active) throw new Error("The recording identity is unavailable");
      await store.discard("unassigned", active.id);
      setNotice("Recording discarded from this device.");
    } catch (error) {
      setNotice("Couldn't discard this recording on this device. The recording is kept.");
      throw error;
    }
  };
  const leave = async () => {
    if (!ready || leaving) return;
    setLeaving(true);
    try { await capture.stop(); await store.stop("user"); onContinue(); }
    catch { setNotice("Couldn't finish saving the recording. Stay here and try again."); setLeaving(false); }
  };
  return <main data-local-capture-screen="" className="min-h-[100dvh] bg-background px-4 py-8 text-foreground">
    <div className="mx-auto flex w-full max-w-[480px] flex-col gap-5">
      <h1 ref={heading} tabIndex={-1} className="font-[family-name:var(--font-display)] text-2xl">Can't reach your server</h1>
      {signOutNotice && <p role="status" className="rounded-xl border border-border bg-surface p-3 text-sm">{signOutNotice}</p>}
      <p className="text-sm">You can record a voice note on this device and transcribe it once you're back online and signed in.</p>
      <p className="rounded-xl border border-border bg-surface p-3 text-sm">Recordings made here aren't linked to your account yet. Anyone using this browser can play them. After you sign in you'll choose whether to add them to your account.</p>
      {reachable && <div role="status" className="rounded-xl border border-border bg-surface p-3">
        <p className="mb-2 text-sm">Your server is back.</p>
        <Button label="Continue" block={false} style={{ minHeight: 44 }} disabled={!ready || leaving} onClick={() => void leave()} />
      </div>}
      <div ref={area}>
        <LocalRecordingSheet inline store={store} open={phase === "recording" || phase === "stopping"} onStop={stop} onDiscard={discard} />
        <div ref={record}><Button label={phase === "opening" ? "Opening microphone…" : "Record on this device"} style={{ minHeight: 44 }} disabled={!ready || phase !== "idle" || leaving} onClick={() => void capture.start()} /></div>
      </div>
      {denied && <p role="status" className="text-sm">Brain can't use the microphone. Allow it in your browser's site settings, then tap Record again.</p>}
      {error && <p role="alert" className="text-sm">{error}</p>}
      <p role="status" className="text-sm text-muted-foreground">{ready ? notice : notice || "Checking recordings on this device…"}</p>
      <section aria-label="Drafts on this device" className="space-y-3">
        <h2 className="text-sm font-mono">Drafts on this device · {rows.length} · {size(rows.reduce((n, row) => n + row.bytes, 0))}</h2>
        {removed && <p className="text-sm">{removed}</p>}
        {rows.map(row => <RecordingItem store={store} key={row.id} row={row} offline localOnly onAccepted={() => {}} onDiscard={async () => { await store.discard("unassigned", row.id); focusRecord(); }} />)}
      </section>
      {lockedBytes !== null && lockedBytes > 0 && <p data-locked-recordings="" className="text-sm text-muted-foreground">Locked recordings · {size(lockedBytes)}<br />Sign in to open them.</p>}
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span>Retrying connection…</span>
        <Button label="Try now" tone="ghost" block={false} style={{ minHeight: 44 }} onClick={root.recheckVpn} />
      </div>
    </div>
  </main>;
}
