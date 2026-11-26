import { useEffect, useMemo, useRef, useState } from "react";
import { GoogleApprovalList, type GoogleApprovalListProps } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { approvalAccounts, googleStandingApi, standingFailure, unshownNotice } from "../../lib/google-standing.js";

/** Not this owner's to see, or a server without the route: no section. */
const HIDE = [401, 403, 404];
const LOAD_FAILED = "Remembered Gmail approvals didn't load. Open Settings again to try again.";

interface Shown {
  state: GoogleApprovalListProps["state"];
  accounts: GoogleApprovalListProps["accounts"];
  unshown: number;
  error: string | null;
}

/**
 * Remembered Gmail approvals in Settings › Security (#4212): the container
 * for the kit's `GoogleApprovalList`, beside the always-allowed tools.
 *
 * As that section does, it appears only once there is something to manage:
 * nothing is drawn while the first read is pending, nor when it finds no
 * approvals, so a host that has never connected Gmail shows no Gmail section.
 * Once drawn, it stays for this visit, so revoking the last row leaves the
 * kit's empty state and its focus rule, not a vanished list. A 503 is the
 * kit's unavailable state; 401, 403 and 404 hide the section.
 *
 * A revoke answered `revoked: true` drops the row here. `revoked: false` means
 * it was already gone, so the list is read again rather than reporting an
 * error.
 */
export function GoogleApprovalsSection({ active }: { active: boolean }) {
  const root = useBrainUiRoot();
  const api = useMemo(() => googleStandingApi(root), [root]);
  const lifetime = useRef(0);
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load(generation: number) {
    try {
      const approvals = await api.approvals();
      if (generation !== lifetime.current) return;
      const { accounts, unshown } = approvalAccounts(approvals, Date.now());
      setShown(was => (was === null && accounts.length === 0 && unshown === 0 ? null : { state: "ready", accounts, unshown, error: null }));
    } catch (err) {
      if (generation !== lifetime.current) return;
      const failure = standingFailure(err, HIDE);
      if (failure === "hidden") setShown(null);
      else if (failure === "unavailable") setShown({ state: "unavailable", accounts: [], unshown: 0, error: null });
      // The kit has no failed-read state; its ready state would claim there are none.
      else setShown(was => (was?.state === "ready" ? { ...was, error: LOAD_FAILED } : { state: "loading", accounts: [], unshown: 0, error: LOAD_FAILED }));
    }
  }

  useEffect(() => {
    const generation = ++lifetime.current;
    setShown(null);
    setBusy(null);
    if (active) void load(generation);
    const invalidate = () => { lifetime.current++; };
    return invalidate;
    // `load` reads `api` and the lifetime only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, api]);

  async function revoke(id: string) {
    if (busy !== null) return;
    const generation = lifetime.current;
    setBusy(id);
    setShown(was => was && { ...was, error: null });
    try {
      const revoked = await api.revokeApproval(id);
      if (generation !== lifetime.current) return;
      if (revoked) {
        setShown(was => was && {
          ...was,
          accounts: was.accounts
            .map(account => ({ ...account, approvals: account.approvals.filter(approval => approval.id !== id) }))
            .filter(account => account.approvals.length > 0),
        });
      } else await load(generation);
    } catch (err) {
      if (generation !== lifetime.current) return;
      if (standingFailure(err, HIDE) === "hidden") setShown(null);
      else setShown(was => was && { ...was, error: err instanceof Error ? err.message : "Could not revoke" });
    } finally {
      if (generation === lifetime.current) setBusy(null);
    }
  }

  if (!shown) return null;
  return (
    <div className="mt-6" data-google-approvals-section="">
      <GoogleApprovalList
        state={shown.state}
        accounts={shown.accounts}
        busy={busy}
        error={shown.error ?? unshownNotice(shown.unshown, "approval")}
        onRevoke={id => void revoke(id)}
      />
    </div>
  );
}
