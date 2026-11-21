import { useState } from "react";
import type { CodeChangeReceipt } from "@schlessera/brain-ui-sdk/protocol";
import { Button, DiffBlock } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";

/** One checkout entry inside the existing turn history. */
export function CodeChanges({ receipt, sessionId, turnId }: { receipt: CodeChangeReceipt; sessionId: string; turnId: string }) {
  const root = useBrainUiRoot();
  const [preview, setPreview] = useState<{ inline: boolean; diff?: string; reason?: string } | null>(null);
  const [confirming, setConfirming] = useState(false), [pending, setPending] = useState(false);
  const [operation, setOperation] = useState<string | null>(null), [message, setMessage] = useState("");
  const [conflict, setConflict] = useState<{ expected?: string; currentPreview?: { inline: boolean; diff?: string; reason?: string }; current?: { tree_after: string; paths: { path: string; kind: string }[] } } | null>(null);
  function showResult(result: Awaited<ReturnType<typeof root.api.codeChangeRevert>>) {
    setConflict(result.status === "conflict" ? result : null);
    if (result.status === "conflict") void review();
    setMessage(result.status === "restored" ? "Checkout paths restored. Commits and branch refs are unchanged."
      : result.status === "conflict" ? "The checkout has later changes. Review both states before deciding what to keep."
      : result.error ?? "The original operation is still settling. Check its result before another action.");
    if (result.status !== "unknown") setOperation(null);
  }
  async function review() {
    setPending(true);
    try { setPreview(await root.api.codeChangePreview(sessionId, turnId, receipt.checkout)); }
    catch { setMessage("Code change evidence is unavailable. Reopen history to try again."); }
    finally { setPending(false); }
  }
  async function revert() {
    const id = crypto.randomUUID();
    setOperation(id); setPending(true); setConfirming(false);
    try { showResult(await root.api.codeChangeRevert(sessionId, turnId, receipt.checkout, id)); }
    catch { setMessage("The response was lost. Check the original operation before another action."); }
    finally { setPending(false); }
  }
  async function reconcile() {
    if (!operation) return;
    setPending(true);
    try { showResult(await root.api.codeChangeRevertStatus(sessionId, turnId, operation)); }
    catch { setMessage("The original operation is unavailable. Review the checkout before another action."); }
    finally { setPending(false); }
  }
  return <section className="grid gap-2 min-w-0" aria-label={`Code changes ${receipt.checkout}`}>
    <h3 className="font-medium">Code changes · {receipt.checkout}</h3>
    <p>{receipt.paths.length} paths · {receipt.bytes} changed bytes · {receipt.untracked} untracked{receipt.ignore_changed ? " · Ignore rules changed" : ""}{receipt.state !== "complete" ? " · Incomplete endpoint capture" : ""}. Ignored files and intermediate versions are not kept.</p>
    <ul>{receipt.paths.map(path => <li key={path.path} className="break-all">{path.path} · {path.kind}{path.untracked ? " · untracked" : ""}</li>)}</ul>
    <div className="flex flex-wrap gap-2">
      <Button label="Review code changes" size="sm" reach block={false} disabled={pending} onClick={() => { void review(); }} />
      {receipt.state === "complete" && receipt.paths.length > 0 && !operation && <Button label="Revert code changes" size="sm" reach block={false} disabled={pending} onClick={() => setConfirming(true)} />}
      {operation && <Button label="Check original operation" size="sm" reach block={false} disabled={pending} onClick={() => { void reconcile(); }} />}
    </div>
    {confirming && <div className="grid gap-2" role="group" aria-label="Confirm code revert">
      <p>Restore these paths to their earlier tree and remove files this receipt added? A fresh comparison refuses later changes.</p>
      <div className="flex flex-wrap gap-2"><Button label="Confirm code revert" reach block={false} disabled={pending} onClick={() => { void revert(); }} /><Button label="Cancel" reach block={false} onClick={() => setConfirming(false)} /></div>
    </div>}
    {message && <p role="status">{message}</p>}
    {conflict && <div className="break-all"><p>Recorded endpoint: {conflict.expected}</p><p>Current endpoint: {conflict.current?.tree_after}</p><ul>{conflict.current?.paths.map(path => <li key={path.path}>{path.path} · {path.kind}</li>)}</ul></div>}
    {conflict?.currentPreview && <section className="grid gap-2 min-w-0"><h4>Current changes</h4>{conflict.currentPreview.inline ? <div className="max-h-[60vh] overflow-auto min-w-0"><DiffBlock tinted variant="inset" text={conflict.currentPreview.diff ?? ""} /></div> : <p>Current inline diff unavailable ({conflict.currentPreview.reason}).</p>}</section>}
    {preview && <h4>{conflict ? "Recorded changes" : "Endpoint diff"}</h4>}
    {preview && (preview.inline ? <div className="max-h-[60vh] overflow-auto min-w-0"><DiffBlock tinted variant="inset" text={preview.diff ?? ""} /></div> : <p>Inline diff unavailable ({preview.reason}). The path list above is retained.</p>)}
  </section>;
}
