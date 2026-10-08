import { useEffect, useRef, useState } from "react";
import { Button, ChoiceOption } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot, useRootStore } from "../../root-context.js";
import { type Recording, recordingTime } from "../../lib/recordings.js";
import { recordingClock, recordingDuration } from "./recordings-tray.js";
import { LocalWorkDialog } from "./local-work-dialog.js";

/** Selection is empty on every opening. Association neither uploads nor sends. */
export function AssociateRecordings({ onClose }: { onClose: () => void }) {
  const root = useBrainUiRoot();
  const account = useRootStore("connection", s => s.accountKey);
  const [rows, setRows] = useState<Recording[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [audio, setAudio] = useState<{ id: string; url: string } | null>(null);
  const urls = useRef(new Set<{ revoke(): void }>());
  const active = useRef(false);
  const mounted = useRef(true);
  const openedAccount = useRef(account);
  const epoch = useRef(root.authLock.epoch());
  const current = () => mounted.current && account === openedAccount.current && root.stores.connection.getState().accountKey === openedAccount.current && epoch.current === root.authLock.epoch();
  useEffect(() => {
    mounted.current = true;
    const ownedUrls = urls.current;
    let serial = 0;
    const refresh = async () => {
      const generation = ++serial;
      try {
        const kept = await root.recordings!.list("unassigned");
        if (mounted.current && generation === serial) setRows(kept.filter(r => r.state !== "recording"));
      } catch { if (mounted.current) setErrors({ inventory: "Couldn\u0027t read recordings on this device. They are kept." }); }
    };
    void refresh();
    const off = root.recordings?.subscribe(() => void refresh());
    return () => { mounted.current = false; off?.(); for (const url of ownedUrls) url.revoke(); ownedUrls.clear(); };
  }, [root]);
  useEffect(() => { if (account !== openedAccount.current) onClose(); }, [account, onClose]);
  async function add() {
    if (active.current || !current()) return;
    active.current = true; setBusy(true); setErrors({});
    const failures: Record<string, string> = {};
    let added = 0;
    for (const row of rows.filter(r => selected.has(r.id))) {
      if (!current()) break;
      try { await root.recordings!.assign(row.id); added++; }
      catch { failures[row.id] = "Couldn\u0027t add this recording. It is still not linked to an account."; }
    }
    active.current = false;
    if (!current()) return;
    root.localWorkFlow.associated(added);
    setBusy(false); setErrors(failures); setSelected(new Set(Object.keys(failures)));
    if (!Object.keys(failures).length) onClose();
  }
  async function play(row: Recording) {
    try {
      const kept = await root.recordings!.playback("unassigned", row.id);
      if (!current()) { kept.revoke(); return; }
      for (const url of urls.current) url.revoke(); urls.current.clear(); urls.current.add(kept);
      setAudio({ id: row.id, url: kept.url });
    } catch { if (current()) setErrors(e => ({ ...e, [row.id]: "Couldn\u0027t play this recording. It is kept." })); }
  }
  return <LocalWorkDialog title="Drafts recorded before you signed in" onCancel={() => { if (!busy) onClose(); }}>
    <p className="text-sm text-muted-foreground">These {rows.length} recordings are on this device but not linked to any account. Add them to your account to transcribe them.</p>
    <div role="group" aria-label="Recordings to add"><ul className="my-3 space-y-3">
      {rows.map(row => <li key={row.id} className="rounded-lg border border-border p-2">
        <ChoiceOption multiple title={`Add recording from ${recordingClock(row)}, ${recordingDuration(row)}`} subtitle={`${recordingClock(row)} · ${recordingTime(row.durationMs)}`} selected={selected.has(row.id)} onClick={() => { if (busy) return; setSelected(previous => { const next = new Set(previous); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; }); }} />
        <Button label="Play" ariaLabel={`Play recording from ${recordingClock(row)}, ${recordingDuration(row)}`} tone="ghost" block={false} style={{ minHeight: 44, minWidth: 44 }} disabled={busy || !row.chunkCount} onClick={() => void play(row)} />
        {audio?.id === row.id && <audio controls autoPlay src={audio.url} className="mt-2 w-full" />}
        {errors[row.id] && <p role="alert" className="mt-2 text-xs text-destructive">{errors[row.id]}</p>}
      </li>)}
    </ul></div>
    {errors.inventory && <p role="alert" className="text-sm text-destructive">{errors.inventory}</p>}
    <div className="flex flex-wrap gap-2">
      <Button label="Add selected to my account" block={false} style={{ minHeight: 44 }} disabled={busy || !selected.size || !account} onClick={() => void add()} />
      <span data-initial-focus tabIndex={-1}><Button label="Not now" tone="ghost" block={false} style={{ minHeight: 44 }} disabled={busy} onClick={onClose} /></span>
    </div>
  </LocalWorkDialog>;
}
