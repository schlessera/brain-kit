import { useEffect, useRef, useState } from "react";
import { Button } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import { RECORDING_MAX_MS, recordingTime } from "../../lib/recordings.js";

/** Local variant: only state changes and limits announce; timer and meter do not. */
export function LocalRecordingSheet({ open, onStop, onDiscard }: {
  open: boolean;
  onStop: () => Promise<void>;
  onDiscard: () => Promise<void>;
}) {
  const root = useBrainUiRoot();
  const level = useRootStore("voice", s => s.audioLevel);
  const stopping = useRootStore("voice", s => s.local === "stopping");
  const [elapsed, setElapsed] = useState(0);
  const [bytes, setBytes] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const keep = useRef<HTMLDivElement>(null);
  useEffect(() => { if (confirm) keep.current?.querySelector<HTMLElement>("[role=button]")?.focus(); }, [confirm]);
  useEffect(() => {
    if (!open) return;
    const start = performance.now();
    setElapsed(0); setConfirm(false); setMessage("Recording on this device"); setError("");
    const update = () => {
      setElapsed(performance.now() - start);
      void root.recordings?.budget().then(budget => setBytes(budget.bytes)).catch(() => setBytes(null));
    };
    update();
    const timer = setInterval(update, 1000);
    const unwatch = root.recordings?.onEvent(event => { if (event.message) setMessage(event.message); });
    return () => { clearInterval(timer); unwatch?.(); };
  }, [open, root]);
  if (!open) return null;
  const act = (fn: () => Promise<void>) => { void fn().catch(() => setError("Couldn\u0027t delete the recording on this device. The recording is kept.")); };
  return <section role="region" aria-label="Recording on this device" data-local-recording-sheet="" className="absolute inset-x-0 bottom-full z-40 mb-2 rounded-xl border border-border bg-surface p-3 shadow-xl">
    <div className="flex items-center justify-between gap-2 text-sm"><b>Recording on this device</b><span className="font-mono">{recordingTime(elapsed)}</span></div>
    <div role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} className="my-2 h-2 overflow-hidden rounded bg-border"><div className="h-full bg-primary-mark" style={{ width: `${Math.round(level * 100)}%` }} /></div>
    <p className="text-xs text-muted-foreground">Stays on this device. Nothing is uploaded until you tap Transcribe.</p>
    <p className="my-2 text-xs font-mono text-muted-foreground">{recordingTime(Math.max(0, RECORDING_MAX_MS - elapsed))} left{bytes === null ? "" : ` · ${(bytes / (1024 * 1024)).toFixed(1)} MB free for audio`}</p>
    <p role="status" className="text-xs text-muted-foreground">{message}</p>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {confirm ? <>
      <p className="mt-2 text-xs">Discard this recording? This can't be undone.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button label="Discard recording" tone="danger" block={false} style={{ minHeight: 44 }} disabled={stopping} onClick={() => act(onDiscard)} />
        <div ref={keep}><Button label="Keep recording" tone="ghost" block={false} style={{ minHeight: 44 }} disabled={stopping} onClick={() => setConfirm(false)} /></div>
      </div>
    </> : <div className="mt-2 flex flex-wrap gap-2">
      <Button label="Stop and save" block={false} style={{ minHeight: 44, flex: "1 1 auto" }} disabled={stopping} onClick={() => act(onStop)} />
      <Button label="Discard" tone="quiet" block={false} style={{ minHeight: 44 }} disabled={stopping} onClick={() => setConfirm(true)} />
    </div>}
  </section>;
}
