import { useEffect, useMemo, useRef, useState } from "react";
import { GoogleAllowanceList, type GoogleAllowanceListProps } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { allowanceGrants, googleStandingApi, standingFailure, unshownNotice } from "../../lib/google-standing.js";

/** Not this owner's chat, not the owner, or a server without the route: no list. */
const HIDE = [401, 403, 404];
const LOAD_FAILED = "Allowances for this chat didn't load. Open the chat again to try again.";

interface Shown {
  state: GoogleAllowanceListProps["state"];
  grants: GoogleAllowanceListProps["grants"];
  unshown: number;
  error: string | null;
}

/**
 * A restricted chat's Gmail allowances (#4212): the container for the kit's
 * `GoogleAllowanceList`, drawn inside the chat's safety notice
 * (`SessionSafety`) only while that notice reports the chat restricted. Its
 * parent remounts it for each chat and owner, and whenever the chat becomes
 * restricted again, so every appearance reads the host afresh.
 *
 * As Settings' lists do, it appears only once there is something to manage:
 * nothing is drawn while the first read is pending or when it finds no
 * allowance, so a restricted chat that never touched Gmail says nothing about
 * Gmail. Once drawn it stays, so revoking the last card leaves the kit's
 * empty state and its focus rule. A 503 is the kit's unavailable state; 401,
 * 403 and 404 hide the list.
 *
 * Revoke names the granting card. Every answer is followed by a fresh read,
 * because what is left of a card and when it ends belong to the host.
 */
export function GoogleAllowancesPanel({ sessionId }: { sessionId: string }) {
  const root = useBrainUiRoot();
  const api = useMemo(() => googleStandingApi(root), [root]);
  const lifetime = useRef(0);
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load(generation: number) {
    try {
      const allowances = await api.allowances(sessionId);
      if (generation !== lifetime.current) return;
      const { grants, unshown } = allowanceGrants(allowances, Date.now());
      setShown(was => (was === null && grants.length === 0 && unshown === 0 ? null : { state: "ready", grants, unshown, error: null }));
    } catch (err) {
      if (generation !== lifetime.current) return;
      const failure = standingFailure(err, HIDE);
      if (failure === "hidden") setShown(null);
      else if (failure === "unavailable") setShown({ state: "unavailable", grants: [], unshown: 0, error: null });
      // The kit has no failed-read state; its ready state would claim there are none.
      else setShown(was => (was?.state === "ready" ? { ...was, error: LOAD_FAILED } : { state: "loading", grants: [], unshown: 0, error: LOAD_FAILED }));
    }
  }

  useEffect(() => {
    const generation = ++lifetime.current;
    setShown(null);
    setBusy(null);
    void load(generation);
    const invalidate = () => { lifetime.current++; };
    return invalidate;
    // `load` reads `api`, `sessionId` and the lifetime only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, api]);

  async function revoke(cardId: string) {
    if (busy !== null) return;
    const generation = lifetime.current;
    setBusy(cardId);
    setShown(was => was && { ...was, error: null });
    try {
      const revoked = await api.revokeAllowance(sessionId, cardId);
      if (generation !== lifetime.current) return;
      if (revoked) setShown(was => was && { ...was, grants: was.grants.filter(grant => grant.id !== cardId) });
      await load(generation);
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
    <div className="py-2" data-google-allowances-panel="">
      <GoogleAllowanceList
        state={shown.state}
        grants={shown.grants}
        busy={busy}
        error={shown.error ?? unshownNotice(shown.unshown, "allowance")}
        onRevoke={id => void revoke(id)}
      />
    </div>
  );
}
