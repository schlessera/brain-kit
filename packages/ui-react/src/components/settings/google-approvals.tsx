import { useEffect, useMemo, useRef, useState } from "react";
import { GoogleApprovalList, type GoogleApprovalListProps } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { approvalAccounts, googleStandingApi, standingFailure } from "../../lib/google-standing.js";

/** Not this owner's to see, or a server without the route: no section. */
const HIDE = [401, 403, 404];

interface Shown {
  state: GoogleApprovalListProps["state"];
  accounts: GoogleApprovalListProps["accounts"];
  unshown: number;
}

const NONE: Omit<Shown, "state"> = { accounts: [], unshown: 0 };

/**
 * Remembered Gmail approvals in Settings › Security (#4212): the container
 * for the kit's `GoogleApprovalList`, beside the always-allowed tools.
 *
 * As that section does, it appears only once there is something to manage:
 * nothing is drawn while the first read is pending, nor when it finds no
 * approvals, so a host that has never connected Gmail shows no Gmail section.
 * Once drawn, it stays for this visit, so revoking the last row leaves the
 * kit's empty state and its focus rule, not a vanished list. Approvals the
 * host cannot name are counted (`unshown`), so the kit never calls them none.
 *
 * Every read maps the same way: a 503 is the kit's unavailable state; 401,
 * 403 and 404 hide the section; anything else, a malformed success included,
 * is the kit's failed state, with Try again.
 *
 * A revoke answered `revoked: true` drops the row here. `revoked: false` means
 * it was already gone, so the list is read again rather than reporting an
 * error. A revoke answered 503, 401, 403 or 404 maps as a read does and reads
 * nothing more. Any other failed revoke keeps its banner over whatever the
 * read that follows finds, unless that read hides the section, because a
 * revoke whose answer was lost may still have happened.
 *
 * Every answer is applied only to the visit and the read that asked for it:
 * closing Settings or switching tabs ends the visit (`lifetime`), and a read
 * answers only if no later read has started (`reads`). A revoke answer that
 * removes a row or changes the section's state supersedes every read started
 * before it.
 */
export function GoogleApprovalsSection({ active }: { active: boolean }) {
  const root = useBrainUiRoot();
  const api = useMemo(() => googleStandingApi(root), [root]);
  const lifetime = useRef(0);
  const reads = useRef(0);
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function fail(err: unknown) {
    const failure = standingFailure(err, HIDE);
    if (failure === "hidden") { setShown(null); setError(null); }
    else setShown({ state: failure, ...NONE });
  }

  async function load(generation: number) {
    const read = ++reads.current;
    try {
      const approvals = await api.approvals();
      if (generation !== lifetime.current || read !== reads.current) return;
      const { accounts, unshown } = approvalAccounts(approvals, Date.now());
      setShown(was => (was === null && accounts.length === 0 && unshown === 0 ? null : { state: "ready", accounts, unshown }));
    } catch (err) {
      if (generation !== lifetime.current || read !== reads.current) return;
      fail(err);
    }
  }

  useEffect(() => {
    const generation = ++lifetime.current;
    setShown(null);
    setBusy(null);
    setError(null);
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
    setError(null);
    try {
      const revoked = await api.revokeApproval(id);
      if (generation !== lifetime.current) return;
      if (revoked) {
        // A read sent before this answer may still hold the revoked row.
        reads.current++;
        setShown(was => was && {
          ...was,
          accounts: was.accounts
            .map(account => ({ ...account, approvals: account.approvals.filter(approval => approval.id !== id) }))
            .filter(account => account.approvals.length > 0),
        });
      } else await load(generation);
    } catch (err) {
      if (generation !== lifetime.current) return;
      if (standingFailure(err, HIDE) !== "failed") {
        // As for a removed row: no read sent before this answer may undo it.
        reads.current++;
        fail(err);
      } else {
        setError(err instanceof Error ? err.message : "Could not revoke");
        await load(generation);
      }
    } finally {
      if (generation === lifetime.current) setBusy(null);
    }
  }

  function retry() {
    const generation = lifetime.current;
    setShown({ state: "loading", ...NONE });
    void load(generation);
  }

  if (!shown) return null;
  return (
    <div className="mt-6" data-google-approvals-section="">
      <GoogleApprovalList
        state={shown.state}
        accounts={shown.accounts}
        unshown={shown.unshown}
        busy={busy}
        error={error}
        onRevoke={id => void revoke(id)}
        onRetry={retry}
      />
    </div>
  );
}
