import { AssociateRecordings } from "./associate-recordings.js";
import { Fragment, useEffect, useId, useRef, useState, useCallback, type RefObject } from "react";
import { Button, RecordingRow } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import { accountPartition } from "../../lib/local-partitions.js";
import { recordingTime, TRANSCRIPT_CHANGED, RECORDING_UNAVAILABLE, type RecordingStore, type Recording } from "../../lib/recordings.js";

export const SAVED_AUDIO_UNAVAILABLE = "Transcribing saved recordings isn\u0027t available on this server yet. Your recording is kept. Play it back and type, or keep it for later.";
export const ACCEPT_FAILED = "Couldn\u0027t save your draft on this device. The recording is kept.";
const target = { minHeight: 44, minWidth: 44 };
const EMPTY_ROWS: Recording[] = [];
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
  const [associate, setAssociate] = useState(false);
  const [notice, setNotice] = useState("");
  const listId = useId();
  const tray = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
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
      if (live && root.stores.connection.getState().accountKey === account) setInventory(current => {
        const notices = recover ? removed : current.account === account ? current.removed : [];
        if (generation !== serial) return recover && current.account === account ? { ...current, removed: notices } : current;
        return { account, rows: rows.filter(r => r.state !== "recording").sort((a, b) => Number(a.partition === "unassigned") - Number(b.partition === "unassigned") || (b.createdAt ?? 0) - (a.createdAt ?? 0)), removed: notices };
      });
    };
    const update = () => { void refresh().catch(() => {}); };
    const unwatch = store.subscribe(update);
    void refresh(true).catch(() => {});
    setNotice("");
    return () => { live = false; unwatch(); };
  }, [root, account]);
  const rows = inventory.account === account ? inventory.rows : EMPTY_ROWS;
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  useEffect(() => {
    if (focusAfter === null) return;
    if (rows.some(r => r.id === focusAfter)) return;
    const next = list.current?.hidden ? null : tray.current?.querySelector<HTMLElement>("[data-recording-focus]");
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
    if (nextId && list.current && !list.current.hidden) nodes[at + 1]?.focus({ preventScroll: true });
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
      <div ref={list} id={listId} hidden={!open} className="min-h-0 space-y-2 overflow-y-auto px-2 pb-2">
        <p className="px-1 text-xs text-muted-foreground">Kept in this browser. Not protected from someone who can use this device.</p>
        {rows.map((row, i) => <Fragment key={`${row.partition}/${row.id}`}>
          {row.partition === "unassigned" && rows[i - 1]?.partition !== "unassigned" && <p className="px-1 text-xs text-muted-foreground">Not linked to an account</p>}
          <RecordingItem onAssociate={account ? () => setAssociate(true) : undefined} row={row} offline={offline} onDiscard={() => remove(row)} onAccepted={() => {
          setNotice("Added to your draft. The recording was deleted from this device.");
          onAccepted?.();
          setTimeout(focusComposer, 0);
        }} /></Fragment>)}
      </div>
    </div>}
    {associate && account && <AssociateRecordings onClose={() => setAssociate(false)} />}
  </>;
}

export function RecordingItem({ row, offline, onDiscard, onAccepted, onAssociate, localOnly = false, store }: { onAssociate?: () => void; row: Recording; offline: boolean; onDiscard: () => Promise<void>; onAccepted: () => void; localOnly?: boolean; store?: RecordingStore }) {
  const root = useBrainUiRoot();
  const recordings = store ?? root.recordings!;
  const [confirm, setConfirm] = useState(false);
  const [text, setText] = useState(row.transcript ?? "");
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const chain = useRef(Promise.resolve());
  const observedTranscript = useRef(row.transcript);
  const dirty = useRef(false);
  const editVersion = useRef(0);
  const [savedVersion, setSavedVersion] = useState(0);
  useEffect(() => {
    if (row.state === "accepted" || (!dirty.current && observedTranscript.current !== row.transcript)) {
      setText(row.transcript ?? "");
      observedTranscript.current = row.transcript;
    }
  }, [row.state, row.transcript, savedVersion]);
  const mounted = useRef(true);
  const keep = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const playback = useRef<{ url: string; revoke(): void } | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { if (confirm) keep.current?.querySelector<HTMLElement>("[role=button]")?.focus(); }, [confirm]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; playback.current?.revoke(); }; }, []);
  const name = `recording from ${recordingClock(row)}, ${recordingDuration(row)}`;
  const run = async (fn: () => Promise<void>) => {
    if (active.current) return;
    active.current = true; setBusy(true); setError("");
    try { await chain.current.catch(() => {}); await fn(); }
    catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "The recording is kept."); }
    finally { active.current = false; if (mounted.current) setBusy(false); }
  };
  const play = () => void run(async () => {
    playback.current?.revoke();
    const audio = await recordings.playback(row.partition, row.id);
    if (!mounted.current) { audio.revoke(); return; }
    playback.current = audio; setUrl(audio.url);
  });
  const accept = () => {
    const chat = root.stores.chat.getState();
    const draftId = root.stores.drafts.getState().idFor(chat.activeSessionId);
    const sessionId = chat.activeSessionId;
    const version = editVersion.current;
    const authEpoch = root.authLock.epoch();
    void run(async () => {
      try {
        if (authEpoch !== root.authLock.epoch() || root.authLock.state.getState().phase !== "active") throw new Error(ACCEPT_FAILED);
        try { await chain.current; }
        catch (error) {
          if (!dirty.current) throw error;
          // Retry the displayed correction after a failed input transaction.
          // Never swallow that failure and accept the older stored text.
          chain.current = recordings.saveTranscript(row.partition, row.id, text);
          await chain.current;
          if (editVersion.current === version) { dirty.current = false; if (mounted.current) setSaveError(""); }
          if (mounted.current) setSavedVersion(version);
        }
        await recordings.accept(row.partition, row.id, draftId, sessionId, text);
      }
      catch (error) { throw new Error(error instanceof Error && (error.message === TRANSCRIPT_CHANGED || error.message === RECORDING_UNAVAILABLE) ? error.message : ACCEPT_FAILED); }
      onAccepted();
    });
  };
  return <div tabIndex={-1} data-recording-focus={row.id} aria-label={name}>
    <RecordingRow time={recordingClock(row)} length={recordingTime(row.durationMs)} durationLabel={recordingDuration(row)} state={row.state} savedThrough={recordingTime(row.savedThroughMs)} interrupted={row.interruptedAt !== undefined} offline={offline}>
      {!localOnly && (row.state === "transcript-ready" || row.state === "accepted") && <>
        <label className="mt-2 block text-xs text-muted-foreground">Transcript · from {recordingClock(row)} recording
          <textarea aria-label={`Transcript of ${name}`} value={text} disabled={busy || row.state === "accepted"} className="mt-1 block min-h-24 w-full rounded-lg border border-border bg-background p-2 text-sm text-foreground" onChange={event => {
            const value = event.target.value; setText(value); dirty.current = true;
            const version = ++editVersion.current;
            // Input writes serialize. Acceptance waits for the newest edit;
            // a failed edit prevents acceptance of older stored text.
            chain.current = chain.current.catch(() => {}).then(() => recordings.saveTranscript(row.partition, row.id, value));
            void chain.current.then(() => {
              if (version === editVersion.current) { dirty.current = false; if (mounted.current) setSaveError(""); }
              if (mounted.current) setSavedVersion(version);
            }, () => { if (mounted.current) setSaveError("Couldn\u0027t save the transcript on this device. The recording is kept."); });
          }} />
        </label>
        <p className="mt-2 text-xs text-muted-foreground">The recording stays on this device until you accept or discard.</p>
      </>}
      <div ref={actions} className="mt-2 flex flex-wrap gap-2">
        {!localOnly && (row.state === "transcript-ready" || row.state === "accepted") && row.partition !== "unassigned" && <Button label="Add to draft" ariaLabel={`Add transcript of ${name} to draft`} block={false} style={target} disabled={busy || !text.trim()} onClick={accept} />}
        {!localOnly && row.partition === "unassigned" && onAssociate && <Button label="Add to my account…" block={false} style={target} disabled={busy} onClick={onAssociate} />}
        <Button label="Play" ariaLabel={`Play ${name}`} tone="ghost" block={false} style={target} disabled={busy || row.chunkCount === 0} onClick={play} />
        <Button label="Discard…" ariaLabel={`Discard ${name}`} tone="quiet" block={false} style={target} disabled={busy} onClick={() => setConfirm(true)} />
      </div>
      {row.chunkCount === 0 && <p className="mt-2 text-xs text-muted-foreground">Audio is no longer available on this device. Your transcript is kept.</p>}
      {url && <audio controls autoPlay src={url} aria-label={`Playback of ${name}`} className="mt-2 w-full" />}
      {confirm && <div role="group" aria-label={`Delete ${name}`} className="mt-2">
        <p className="text-xs">Delete the recording and its transcript from this device?</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button label="Delete" ariaLabel={`Delete ${name}`} tone="danger" block={false} style={target} disabled={busy} onClick={() => void run(onDiscard)} />
          <div ref={keep}><Button label="Keep" tone="ghost" block={false} style={target} disabled={busy} onClick={() => { setConfirm(false); setTimeout(() => actions.current?.querySelector<HTMLElement>('[aria-label^="Discard recording"]')?.focus(), 0); }} /></div>
        </div>
      </div>}
      {!localOnly && <p className="mt-2 text-xs text-muted-foreground">{offline ? "Transcribe · needs the host" : SAVED_AUDIO_UNAVAILABLE}</p>}
      {saveError && <p role="alert" className="mt-2 text-xs text-destructive">{saveError}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </RecordingRow>
  </div>;
}
