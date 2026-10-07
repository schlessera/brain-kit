import { Fragment, useEffect, useId, useRef, useState, useCallback, type RefObject } from "react";
import { Button, RecordingRow } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import { accountPartition } from "../../lib/local-partitions.js";
import { recordingTime, type Recording } from "../../lib/recordings.js";

export const SAVED_AUDIO_UNAVAILABLE = "Transcribing saved recordings isn\u0027t available on this server yet. Your recording is kept. Play it back and type, or keep it for later.";
export const ACCEPT_FAILED = "Couldn\u0027t save your draft on this device. The recording is kept.";
const target = { minHeight: 44, minWidth: 44 };
const size = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
export function recordingClock(row: Recording): string {
  if (row.createdAt === undefined) return "unknown time";
  const date = new Date(row.createdAt);
  return `${date.getHours().toString().padStart(2, "0")}:${date.getMinutes().toString().padStart(2, "0")}`;
}
export function recordingDuration(row: Recording): string {
  const seconds = Math.floor(row.durationMs / 1000);
  return `${Math.floor(seconds / 60)} minutes ${seconds % 60} seconds`;
}

/** Readable partitions only. Auth changes hide stale async results before paint. */
export function RecordingsTray({ composerRef, onAccepted }: {
  composerRef?: RefObject<HTMLDivElement | null>;
  onAccepted?: () => void;
}) {
  const root = useBrainUiRoot();
  const account = useRootStore("connection", s => s.accountKey);
  const offline = useRootStore("connection", s => s.wsStatus !== "connected");
  const [inventory, setInventory] = useState<{ account: string | null; rows: Recording[]; removed: string[] }>({ account, rows: [], removed: [] });
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const listId = useId();
  const tray = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLButtonElement>(null);
  const focusComposer = useCallback(() => {
    const field = composerRef?.current?.querySelector<HTMLTextAreaElement>("textarea[data-composer]");
    field?.focus({ preventScroll: true });
    field?.setSelectionRange(field.value.length, field.value.length);
  }, [composerRef]);
  useEffect(() => {
    const store = root.recordings;
    if (!store) return;
    let live = true;
    let serial = 0;
    const readable = account ? [accountPartition(account), "unassigned" as const] : ["unassigned" as const];
    const refresh = async (recover = false) => {
      const generation = ++serial;
      const rows: Recording[] = [];
      const removed: string[] = [];
      for (const partition of readable) {
        if (recover) {
          try {
            const result = await store.recover(partition);
            rows.push(...result.recordings);
            if (result.removedMessage) removed.push(result.removedMessage);
            continue;
          } catch { /* A live recorder owns recovery; its committed inventory is still readable. */ }
        }
        rows.push(...await store.list(partition));
      }
      if (live && generation === serial && root.stores.connection.getState().accountKey === account) setInventory({ account, rows: rows.filter(r => r.state !== "recording").sort((a, b) => Number(a.partition === "unassigned") - Number(b.partition === "unassigned") || (b.createdAt ?? 0) - (a.createdAt ?? 0)), removed });
    };
    const update = () => { void refresh().catch(() => {}); };
    const unwatch = store.subscribe(update);
    void refresh(true).catch(() => {});
    setNotice("");
    return () => { live = false; unwatch(); };
  }, [root, account]);
  const rows = inventory.account === account ? inventory.rows : [];
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  useEffect(() => {
    if (focusAfter === null) return;
    if (rows.some(r => r.id === focusAfter)) return;
    const next = tray.current?.querySelector<HTMLElement>("[data-recording-focus]");
    (next ?? header.current)?.focus({ preventScroll: true });
    if (!rows.length) focusComposer();
    setFocusAfter(null);
  }, [focusAfter, rows, focusComposer]);
  const remove = async (row: Recording) => {
    const nodes = [...(tray.current?.querySelectorAll<HTMLElement>("[data-recording-focus]") ?? [])];
    const at = nodes.findIndex(n => n.dataset.recordingFocus === row.id);
    const nextId = nodes[at + 1]?.dataset.recordingFocus;
    await root.recordings!.discard(row.partition, row.id);
    setInventory(current => ({ ...current, rows: current.rows.filter(r => r.id !== row.id) }));
    if (nextId) nodes[at + 1]?.focus({ preventScroll: true });
    else if (rows.length > 1) header.current?.focus({ preventScroll: true });
    else { setFocusAfter(row.id); }
  };
  return <>
    <div className="sr-only" aria-live="polite" data-recording-live="">{notice}</div>
    {inventory.account === account && inventory.removed.map(text => <p key={text} className="text-xs text-muted-foreground">{text}</p>)}
    {rows.length > 0 && <div ref={tray} className="mb-2 rounded-xl border border-border bg-surface" data-recordings-tray="" style={{ maxWidth: 720, marginInline: "auto", maxHeight: "40vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <button ref={header} type="button" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(v => !v)} className="flex w-full items-center justify-between gap-2 px-3 text-xs font-mono" style={{ minHeight: 44 }}>
        <span>On this device · {rows.length} · {size(rows.reduce((n, r) => n + r.bytes, 0))}</span><span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && <div id={listId} className="min-h-0 space-y-2 overflow-y-auto px-2 pb-2">
        <p className="px-1 text-xs text-muted-foreground">Kept in this browser. Not protected from someone who can use this device.</p>
        {rows.map((row, i) => <Fragment key={`${row.partition}/${row.id}`}>
          {row.partition === "unassigned" && rows[i - 1]?.partition !== "unassigned" && <p className="px-1 text-xs text-muted-foreground">Not linked to an account</p>}
          <RecordingItem row={row} offline={offline} onDiscard={() => remove(row)} onAccepted={() => {
          setNotice("Added to your draft. The recording was deleted from this device.");
          onAccepted?.();
          setTimeout(focusComposer, 0);
        }} /></Fragment>)}
      </div>}
    </div>}
  </>;
}

function RecordingItem({ row, offline, onDiscard, onAccepted }: { row: Recording; offline: boolean; onDiscard: () => Promise<void>; onAccepted: () => void }) {
  const root = useBrainUiRoot();
  const [confirm, setConfirm] = useState(false);
  const [text, setText] = useState(row.transcript ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const chain = useRef(Promise.resolve());
  const previousState = useRef(row.state);
  useEffect(() => {
    if (previousState.current !== row.state && row.state === "transcript-ready") setText(row.transcript ?? "");
    previousState.current = row.state;
  }, [row.state, row.transcript]);
  const mounted = useRef(true);
  const keep = useRef<HTMLDivElement>(null);
  const playback = useRef<{ url: string; revoke(): void } | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { if (confirm) keep.current?.querySelector<HTMLElement>("[role=button]")?.focus(); }, [confirm]);
  useEffect(() => () => { mounted.current = false; playback.current?.revoke(); }, []);
  const name = `recording from ${recordingClock(row)}, ${recordingDuration(row)}`;
  const run = async (fn: () => Promise<void>) => {
    if (active.current) return;
    active.current = true; setBusy(true); setError("");
    try { await chain.current; await fn(); }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "The recording is kept."); }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  };
  const play = () => void run(async () => {
    playback.current?.revoke();
    const audio = await root.recordings!.playback(row.partition, row.id);
    if (!mounted.current) { audio.revoke(); return; }
    playback.current = audio; setUrl(audio.url);
  });
  const accept = () => void run(async () => {
    const chat = root.stores.chat.getState();
    const drafts = root.stores.drafts.getState();
    try { await root.recordings!.accept(row.partition, row.id, drafts.idFor(chat.activeSessionId), chat.activeSessionId); }
    catch { throw new Error(ACCEPT_FAILED); }
    onAccepted();
  });
  return <div tabIndex={-1} data-recording-focus={row.id} aria-label={name}>
    <RecordingRow time={recordingClock(row)} length={recordingTime(row.durationMs)} durationLabel={recordingDuration(row)} state={row.state} savedThrough={recordingTime(row.savedThroughMs)} offline={offline}>
      {(row.state === "transcript-ready" || row.state === "accepted") && <>
        <label className="mt-2 block text-xs text-muted-foreground">Transcript · from {recordingClock(row)} recording
          <textarea aria-label={`Transcript of ${name}`} value={text} disabled={busy || row.state === "accepted"} className="mt-1 block min-h-24 w-full rounded-lg border border-border bg-background p-2 text-sm text-foreground" onChange={event => {
            const value = event.target.value; setText(value);
            // Input writes serialize. Acceptance waits for the newest edit;
            // a failed edit prevents acceptance of older stored text.
            chain.current = chain.current.catch(() => {}).then(() => root.recordings!.saveTranscript(row.partition, row.id, value));
            void chain.current.then(() => { if (mounted.current) setError(""); }, () => { if (mounted.current) setError("Couldn\u0027t save the transcript on this device. The recording is kept."); });
          }} />
        </label>
        <p className="mt-2 text-xs text-muted-foreground">The recording stays on this device until you accept or discard.</p>
      </>}
      <div className="mt-2 flex flex-wrap gap-2">
        {(row.state === "transcript-ready" || row.state === "accepted") && row.partition !== "unassigned" && <Button label="Add to draft" ariaLabel={`Add transcript of ${name} to draft`} block={false} style={target} disabled={busy || !text.trim()} onClick={accept} />}
        <Button label="Play" ariaLabel={`Play ${name}`} tone="ghost" block={false} style={target} disabled={busy} onClick={play} />
        <Button label="Discard…" ariaLabel={`Discard ${name}`} tone="quiet" block={false} style={target} disabled={busy} onClick={() => setConfirm(true)} />
      </div>
      {url && <audio controls autoPlay src={url} aria-label={`Playback of ${name}`} className="mt-2 w-full" />}
      {confirm && <div role="group" aria-label={`Delete ${name}`} className="mt-2">
        <p className="text-xs">Delete the recording and its transcript from this device?</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button label="Delete" ariaLabel={`Delete ${name}`} tone="danger" block={false} style={target} disabled={busy} onClick={() => void run(onDiscard)} />
          <div ref={keep}><Button label="Keep" tone="ghost" block={false} style={target} disabled={busy} onClick={() => setConfirm(false)} /></div>
        </div>
      </div>}
      <p className="mt-2 text-xs text-muted-foreground">{offline ? "Transcribe · needs the host" : SAVED_AUDIO_UNAVAILABLE}</p>
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </RecordingRow>
  </div>;
}
