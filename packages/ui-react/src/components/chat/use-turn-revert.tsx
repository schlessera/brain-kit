import { Button, Overlay } from "@schlessera/brain-ui-kit";
import type { TurnRevertPlan, TurnRevertReceipt, TurnHistoryAction, JournalObservationReference } from "@schlessera/brain-ui-sdk/protocol";
import { useEffect, useRef, useState } from "react";
import { useBrainUiRoot } from "../../root-context.js";

const pending = (receipt: TurnRevertReceipt | null) => !!receipt && ["waiting", "applying", "unknown"].includes(receipt.state);
const copy = (receipt: TurnRevertReceipt) => receipt.state === "waiting" ? "Waiting for running turns." : receipt.state === "applying" ? "Restoring observed files…" : receipt.state === "unknown" ? "The original operation's outcome is unknown. Check its receipt before taking another action." : receipt.state === "failed" ? "The operation could not complete. Check its receipt; partial work may remain." : receipt.state === "partial" ? "Some paths were skipped or could not be restored. Partial work remains." : "Observed files restored. This user operation was recorded in the journal.";

/** Operation ownership follows the original session/turn, even if its POST response is lost. */
export function useTurnRevert(sessionId: string | null, turnId: string | undefined, enabled: boolean, open: boolean, returnFocus: () => HTMLElement | null) {
  const root = useBrainUiRoot(), key = `${sessionId ?? ""}\0${turnId ?? ""}`, identity = useRef(key); identity.current = key;
  const [plan, setPlan] = useState<TurnRevertPlan | null>(null), [restorePlan, setRestorePlan] = useState<TurnRevertPlan | null>(null);
  const [receipt, setReceipt] = useState<TurnRevertReceipt | null>(null), [review, setReview] = useState<TurnRevertPlan | null>(null), [error, setError] = useState<string | null>(null), [posting, setPosting] = useState(false);
  const postingRef = useRef(false), controlsRef = useRef<HTMLDivElement>(null), reviewTrigger = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null), operation = useRef<string | null>(null), announced = useRef<string | null>(null);
  const latestReceipt = useRef<TurnRevertReceipt | null>(null);
  const [announcement, setAnnouncement] = useState(""), [loadedKey, setLoadedKey] = useState(key);
  useEffect(() => { setLoadedKey(key); setPlan(null); setRestorePlan(null); setReceipt(null); setReview(null); setError(null); setPosting(false); postingRef.current = false; operation.current = null; latestReceipt.current = null; announced.current = null; setAnnouncement(""); }, [key]);
  useEffect(() => {
    if (!enabled || !open || !sessionId || !turnId) return;
    const controller = new AbortController();
    Promise.all([root.api.turnRevertPlan(sessionId, turnId, "revert", controller.signal), root.api.turnRevertPlan(sessionId, turnId, "restore", controller.signal), root.api.turnRevertLatest(sessionId, turnId, controller.signal)]).then(([plan, restore, latest]) => {
      if (controller.signal.aborted) return;
      setPlan(plan); setRestorePlan(restore); if (latest.receipt && !operation.current) { latestReceipt.current = latest.receipt; setReceipt(latest.receipt); }
    }).catch(() => { if (!controller.signal.aborted) setError("Retained history actions are unavailable. No operation was started."); });
    return () => controller.abort();
  }, [root, sessionId, turnId, key, enabled, open]);
  function accept(next: TurnRevertReceipt, ownKey: string) {
    if (identity.current !== ownKey || operation.current && operation.current !== next.id) return;
    if (latestReceipt.current?.id === next.id && ["complete", "partial", "failed"].includes(latestReceipt.current.state) && ["waiting", "applying"].includes(next.state)) return;
    latestReceipt.current = next; setError(null); setReceipt(next); setPosting(false); postingRef.current = false; operation.current = next.id;
    const terminal = !["waiting", "applying"].includes(next.state), announcementKey = `${next.id}:${next.state}`;
    if (terminal && announced.current !== announcementKey) { announced.current = announcementKey; setAnnouncement(copy(next)); }
  }
  async function check() {
    if (!sessionId || !turnId || !receipt) return;
    const ownKey = key;
    try { const next = await root.api.turnRevertReceipt(sessionId, receipt.sourceTurnId, receipt.id); accept(next, ownKey); }
    catch { if (identity.current === ownKey && latestReceipt.current?.id === receipt.id) { setError("The original receipt is unavailable. No operation was retried."); setReceipt(previous => previous ? { ...previous, state: "unknown" } : null); } }
  }
  useEffect(() => {
    if (!receipt || !["waiting", "applying"].includes(receipt.state) || !sessionId) return;
    const controller = new AbortController(), ownKey = key;
    const timer = setInterval(() => {
      root.api.turnRevertReceipt(sessionId, receipt.sourceTurnId, receipt.id, controller.signal).then(value => { if (!controller.signal.aborted) accept(value, ownKey); }).catch(() => {
        if (!controller.signal.aborted && identity.current === ownKey && latestReceipt.current?.id === receipt.id) setReceipt(previous => previous ? { ...previous, state: "unknown" } : null);
      });
    }, 500);
    return () => { clearInterval(timer); controller.abort(); };
  }, [root, key, sessionId, receipt?.id, receipt?.sourceTurnId, receipt?.state]);
  async function start(sourceTurnId: string, action: TurnHistoryAction, path?: string, choice?: {version:JournalObservationReference;expected:JournalObservationReference;otherVersion?:JournalObservationReference}) {
    if (!sessionId || postingRef.current || pending(latestReceipt.current)) return;
    const ownKey = key, id = crypto.randomUUID(); operation.current = id; postingRef.current = true; setPosting(true); setError(null); setReview(null);
    const unknown: TurnRevertReceipt = { id, sourceTurnId, journalTurnId: `revert_${id}`, action, state: "unknown", undoAvailable: false, paths: [], error: null, ...(choice ? {resolution:{path:path!,...choice}}:{}) };
    latestReceipt.current = unknown; setReceipt(unknown);
    try { accept(await root.api.turnRevert(sessionId, sourceTurnId, { id, action, ...(path ? { path } : {}), ...(choice??{}) }), ownKey); }
    catch { if (identity.current === ownKey) { setPosting(false); postingRef.current = false; setReceipt(unknown); setError("The response was not confirmed. Check the original receipt; no action will be retried automatically."); } }
  }
  function action(path: string) {
    const eligible = plan?.paths.find(item => item.path === path && item.state === "eligible"), restore = restorePlan?.paths.find(item => item.path === path && item.state === "eligible");
    return loadedKey === key && enabled && (eligible || restore) && <Button label={restore ? "Restore file" : "Revert file"} ariaLabel={`${restore ? "Restore" : "Revert"} ${path}`} block={false} style={{ minHeight: 44 }} disabled={posting || pending(receipt)} onClick={() => void start(turnId!, restore ? "restore" : "revert", path)} />;
  }
  const eligible = review?.paths.filter(item => item.state === "eligible") ?? [];
  const controls = loadedKey === key && enabled && <div ref={controlsRef} className="grid gap-2 min-w-0">
    {plan?.paths.some(item => item.state === "eligible") && <span data-revert-review=""><Button label="Review whole-turn revert" tone="quiet" style={{ minHeight: 44 }} disabled={posting || pending(receipt)} onClick={() => { reviewTrigger.current = controlsRef.current?.querySelector<HTMLElement>("[data-revert-review] [role=button]") ?? null; setReview(plan); }} /></span>}
    {receipt && <div className="grid gap-2 text-sm break-words" data-revert-receipt={receipt.state}>
      <p>{copy(receipt)}</p>
      {receipt.resolution && <p>Selected after observation {receipt.resolution.version.sequence}{receipt.resolution.otherVersion ? ` and ${receipt.resolution.otherVersion.sequence}` : ""}. Writer ownership remains shared.</p>}
      {receipt.error && <p>Recorded outcome: {receipt.error}.</p>}
      {receipt.paths.map(path => <p key={path.path}>{path.path}: {path.state}{path.reason ? ` (${path.reason})` : ""}</p>)}
      {["waiting", "applying", "unknown", "failed"].includes(receipt.state) && <Button label="Check again" tone="quiet" style={{ minHeight: 44 }} disabled={posting} onClick={() => void check()} />}
      {["complete", "partial"].includes(receipt.state) && receipt.undoAvailable && <span data-revert-undo=""><Button label="Undo" tone="quiet" style={{ minHeight: 44 }} onClick={() => {
        reviewTrigger.current = controlsRef.current?.querySelector<HTMLElement>("[data-revert-undo] [role=button]") ?? null;
        const ownKey = key; root.api.turnRevertPlan(sessionId!, receipt.journalTurnId).then(value => { if (identity.current === ownKey) setReview(value); }).catch(() => { if (identity.current === ownKey) { setError("The recorded user operation expired or is unavailable. Undo was not started."); setReceipt(previous => previous ? { ...previous, undoAvailable: false } : null); } });
      }} /></span>}
    </div>}
    {error && <p>{error}</p>}
  </div>;
  const dialog = <Overlay open={loadedKey === key && !!review && enabled} variant="dialog" size="lg" label="Review history operation" initialFocus={heading} returnFocus={() => reviewTrigger.current?.isConnected && reviewTrigger.current.getAttribute("aria-disabled") !== "true" ? reviewTrigger.current : controlsRef.current?.closest("[data-turn-journal]")?.querySelector<HTMLElement>("[role=button][aria-expanded]") ?? returnFocus()} onClose={() => setReview(null)}>
    <div className="p-4 grid gap-4 min-w-0"><h2 ref={heading} tabIndex={-1} className="font-medium">{review?.turnId === turnId ? "Review whole-turn revert" : "Review Undo"}</h2>
      <p>Only retained observed versions can be restored. Paths changed since that observation are skipped; other paths can still be restored. Git history and outward effects remain.</p>
      <ul className="grid gap-2 text-sm break-all">{review?.paths.map(path => <li key={path.path}>{path.path}: {path.state === "eligible" ? "Eligible" : `Excluded (${path.reason})`}</li>)}</ul>
      <Button label={`Revert ${eligible.length} ${eligible.length === 1 ? "file" : "files"}`} style={{ minHeight: 44 }} disabled={!eligible.length || posting || pending(receipt)} onClick={() => void start(review!.turnId, review!.action)} />
      <Button label="Close" tone="quiet" style={{ minHeight: 44 }} onClick={() => setReview(null)} />
    </div>
  </Overlay>;
  return { controls, action, dialog,
    canResolve: loadedKey===key&&enabled,
    resolutionPending: posting||pending(receipt),
    resolve(path:string,action:"keep_version"|"keep_both",version:JournalObservationReference,expected:JournalObservationReference,otherVersion?:JournalObservationReference) {
      if(loadedKey!==key||!enabled)return;
      void start(turnId!,action,path,{version,expected,...(otherVersion?{otherVersion}:{})});
    },
    announcement: <span className="sr-only" role="status" aria-live="polite">{announcement}</span> };
}
