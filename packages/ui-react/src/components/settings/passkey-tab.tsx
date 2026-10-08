import { useCallback, useEffect, useRef, useState } from "react";
import type { PasskeySummary } from "@schlessera/brain-ui-sdk/protocol";
import { useBrainUiRoot } from "../../root-context.js";
import { isUserCancel, registerPasskey, supportsPasskeys } from "../../lib/passkeys.js";
import { Button, ChoiceOption } from "@schlessera/brain-ui-kit";
import { LocalWorkDialog } from "../voice/local-work-dialog.js";
import type { SignOutLoss } from "../../lib/local-work-flow.js";
import { PasskeyList } from "./passkey-list.js";

/**
 * Passkey management + sign out — the Security tab of the settings panel.
 * Registration requires the current session (routes are behind the auth guard);
 * credentials are RP-scoped, so entries registered on another hostname are
 * badged and only useful there.
 *
 * `active` is "this tab is on screen": the list reloads when it becomes visible
 * rather than on mount, so switching tabs picks up changes made elsewhere.
 *
 * This is the container (S6): the request, the ceremony, the per-root abort
 * signal and the confirm dialog live here; `PasskeyList` draws from props.
 */
export function PasskeyTab({ active }: { active: boolean }) {
  const root = useBrainUiRoot();
  const api = root.api;
  const lifetime = useRef(new AbortController());
  const listRequest = useRef(0);
  const [credentials, setCredentials] = useState<PasskeySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loss, setLoss] = useState<SignOutLoss | null>(null);
  const [alsoDelete, setAlsoDelete] = useState(false);
  const [lossChanged, setLossChanged] = useState(false);
  const signOutActive = useRef(false);
  const consentVersion = useRef(0);
  const [passkeyMode, setPasskeyMode] = useState(true);

  const webAuthnSupported = supportsPasskeys();

  const refresh = useCallback(async () => {
    const signal = lifetime.current.signal;
    const request = ++listRequest.current;
    const current = () => !signal.aborted && request === listRequest.current;
    setLoading(true);
    try {
      const data = await api.passkeyList();
      if (!current()) return;
      setCredentials(data.credentials);
      setPasskeyMode(true);
    } catch {
      if (!current()) return;
      // 400 = server not in password mode; anything else degrades the same way.
      setPasskeyMode(false);
      setCredentials([]);
    } finally {
      if (current()) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setCredentials([]);
    setLoading(false);
    setBusy(false);
    setError(null);
    setLoss(null);
    setAlsoDelete(false);
    setLossChanged(false);
    signOutActive.current = false;
    consentVersion.current++;
    setPasskeyMode(true);
    if (active) void refresh();
    return () => controller.abort();
  }, [active, root, refresh]);

  async function onAdd() {
    if (busy) return;
    const signal = lifetime.current.signal;
    setBusy(true);
    setError(null);
    try {
      await registerPasskey(api, undefined, signal);
      if (signal.aborted) return;
      await refresh();
    } catch (err) {
      if (!signal.aborted && !isUserCancel(err)) {
        setError(err instanceof Error ? err.message : "Registration failed");
      }
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  async function onDelete(id: string) {
    if (!window.confirm("Remove this passkey? You can't undo this.")) return;
    const signal = lifetime.current.signal;
    setError(null);
    try {
      await api.passkeyDelete(id);
      if (signal.aborted) return;
      setCredentials((rows) => rows.filter((row) => row.id !== id));
    } catch (err) {
      if (!signal.aborted) setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function onRename(id: string, label: string) {
    const signal = lifetime.current.signal;
    setError(null);
    try {
      await api.passkeyRename(id, label);
      if (signal.aborted) return;
      setCredentials((rows) =>
        rows.map((row) => (row.id === id ? { ...row, label } : row))
      );
    } catch (err) {
      if (!signal.aborted) setError(err instanceof Error ? err.message : "Rename failed");
    }
  }

  async function onSignOut() {
    if (signOutActive.current) return;
    signOutActive.current = true;
    const signal = lifetime.current.signal;
    setError(null);
    try {
      const summary = await root.localWorkFlow.loss();
      if (signal.aborted) return;
      if (summary.recordings || summary.accepted || summary.drafts || summary.tracks || summary.review || summary.unassigned || summary.unknown || summary.otherTabs) {
        setAlsoDelete(false); setLossChanged(false); setLoss(summary);
      } else await root.localWorkFlow.signOut(summary, false, root.localWorkFlow.navigationFor(signal));
    } catch (err) { if (!signal.aborted) setError(err instanceof Error ? err.message : "Sign-out failed"); }
    finally { if (!signal.aborted) signOutActive.current = false; }
  }
  async function confirmSignOut() {
    if (!loss || signOutActive.current) return;
    signOutActive.current = true;
    const signal = lifetime.current.signal;
    const consent = consentVersion.current;
    try {
      const fresh = await root.localWorkFlow.loss();
      if (signal.aborted || consent !== consentVersion.current) return;
      const expanded = (["recordings", "transcripts", "accepted", "drafts", "tracks"] as const).some(key => fresh[key] > loss[key])
        || Number((fresh.bytes / (1024 * 1024)).toFixed(1)) > Number((loss.bytes / (1024 * 1024)).toFixed(1))
        || fresh.review && !loss.review || fresh.unknown && !loss.unknown || fresh.otherUnknown && !loss.otherUnknown
        || alsoDelete && fresh.unassigned > loss.unassigned;
      if (expanded) { setLoss(fresh); setLossChanged(true); if (fresh.unassigned > loss.unassigned) setAlsoDelete(false); return; }
      await root.localWorkFlow.signOut(fresh, alsoDelete, root.localWorkFlow.navigationFor(signal));
    }
    catch (err) { if (!signal.aborted && consent === consentVersion.current) { setError(err instanceof Error ? err.message : "Sign-out failed"); setLoss(null); } }
    finally { if (!signal.aborted) signOutActive.current = false; }
  }
  function cancelSignOut() { consentVersion.current++; setLoss(null); }

  return (
    <>
    <PasskeyList
      credentials={credentials}
      status={loading ? "loading" : passkeyMode ? "ready" : "unavailable"}
      busy={busy}
      error={error}
      supported={webAuthnSupported}
      hostname={typeof window !== "undefined" ? window.location.hostname : ""}
      onAdd={() => void onAdd()}
      onRename={(id, label) => void onRename(id, label)}
      onDelete={(id) => void onDelete(id)}
      onSignOut={() => void onSignOut()}
    />
    {loss && <LocalWorkDialog focusAction title="Sign out of Brain?" onCancel={cancelSignOut}>
      {lossChanged && <p role="alert" className="my-3 text-sm text-foreground">Local work changed. Review the updated warning before signing out.</p>}
      <p className="text-sm text-foreground">This deletes the following from this device:</p>
      <ul className="my-3 list-inside list-disc text-sm text-foreground">
        {loss.recordings > 0 && <li>{loss.recordings} recordings not yet added to a draft · {(loss.bytes / (1024 * 1024)).toFixed(1)} MB · {loss.transcripts} with an unaccepted transcript</li>}
        {loss.accepted > 0 && <li>{loss.accepted} accepted recordings awaiting cleanup</li>}
        {loss.drafts > 0 && <li>{loss.drafts} unsent drafts, including their images</li>}
        {loss.tracks > 0 && <li>{loss.tracks} staged track references</li>}
        {loss.review && <li>Unaccepted dictation text</li>}
      </ul>
      {loss.otherTabs && <p className="my-3 text-sm text-foreground">{loss.otherUnknown ? "Other tabs for this account may have unsaved drafts, dictation or staged track references. Their local work will also be lost. Keep working to review it in those tabs." : "Local work in other tabs for this account is included above."}</p>}
      {loss.unknown && <p role="alert" className="text-sm text-destructive">Local storage could not be read. All local drafts, recordings and transcripts for this account will be deleted if accessible.</p>}
      <p className="text-sm text-foreground">They can't be recovered.</p>
      {loss.unassigned > 0 && <div role="group" aria-label="Unassigned recordings" className="my-3"><ChoiceOption multiple title={`Also delete ${loss.unassigned} recordings not linked to any account`} selected={alsoDelete} onClick={() => { consentVersion.current++; setAlsoDelete(value => !value); }} /></div>}
      <div className="mt-3 flex flex-wrap gap-2">
        <span data-initial-focus tabIndex={-1}><Button label="Keep working" tone="ghost" block={false} style={{ minHeight: 44 }} onClick={cancelSignOut} /></span>
        <Button label="Sign out and delete" tone="danger" block={false} style={{ minHeight: 44 }} onClick={() => void confirmSignOut()} />
      </div>
    </LocalWorkDialog>}
    </>
  );
}
