import { useEffect, useMemo, useRef, useState } from "react";
import { GoogleAllowanceList, type GoogleAllowanceListProps } from "@schlessera/brain-ui-kit";
import { useBrainUiRoot } from "../../root-context.js";
import { useChatStore } from "../../stores/chat-store.js";
import { allowanceGrants, completedAllowanceWrites, googleStandingApi, standingFailure } from "../../lib/google-standing.js";

/** Not this owner's chat, not the owner, or a server without the route: no list. */
const HIDE = [401, 403, 404];

/**
 * How long after a card's end the expiry read waits, and how long after an
 * answer that lists an end already past the reconcile read waits: the host
 * drops a row once its end has passed, and this device's clock may run a
 * little ahead of the host's.
 */
const EXPIRY_GRACE_MS = 1_000;

interface Shown {
  state: GoogleAllowanceListProps["state"];
  grants: GoogleAllowanceListProps["grants"];
  unshown: number;
  /** The earliest shown end still ahead when the answer arrived, in host time. */
  nextEnd: number | null;
  /** When the reconcile read for ends already past is due, on this device's clock; null when none is pending. */
  reconcileAt: number | null;
}

const NONE: Omit<Shown, "state"> = { grants: [], unshown: 0, nextEnd: null, reconcileAt: null };

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
 * empty state and its focus rule. Allowances the host cannot name are
 * counted (`unshown`), so the kit never says nothing is allowed.
 *
 * Every read maps the same way: a 503 is the kit's unavailable state; 401,
 * 403 and 404 hide the list; anything else, a malformed success included, is
 * the kit's failed state, with Try again. A revoke answered 503, 401, 403 or
 * 404 maps the same way and reads nothing more. Any other failed revoke keeps
 * its banner over whatever the read that follows finds, unless that read
 * hides the list, since its answer may have been lost after the host revoked.
 *
 * What is left of a card and when it ends belong to the host, so the list
 * reads again, with no polling:
 * - after every successful revoke answer, and after a failed revoke whose
 *   outcome is uncertain;
 * - when a Gmail modify or draft call in this chat has its result, since it
 *   may have spent a card's changes or granted a new card;
 * - just after the earliest shown end still ahead;
 * - once, just after an answer that lists an end already past by this
 *   device's clock, for each such end: the host still decides that the card
 *   is live, so the card stays shown, and if the next answer still lists that
 *   end nothing more is scheduled for it;
 * - when the page becomes visible again.
 * Each read formats the times afresh. An answer applies only to the
 * appearance that asked for it (`lifetime`) and only if no later read has
 * started (`reads`); a revoke answer that changes the list's state starts
 * none, but supersedes every read started before it.
 */
export function GoogleAllowancesPanel({ sessionId }: { sessionId: string }) {
  const root = useBrainUiRoot();
  const api = useMemo(() => googleStandingApi(root), [root]);
  const lifetime = useRef(0);
  const reads = useRef(0);
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const writes = useChatStore(s => completedAllowanceWrites(s.buffers[sessionId]?.messages));
  const seenWrites = useRef(writes);
  /** Every end already past whose reconcile read has run, this appearance: each is reconciled once. */
  const reconciled = useRef(new Set<number>());
  /**
   * The reconcile read still to run: when it is due and the ends it settles.
   * An answer that lists the same ends before then keeps the deadline; only
   * the read itself marks them reconciled, so a failure or an unmount never
   * counts as one.
   */
  const pending = useRef<{ at: number; ends: number[] } | null>(null);

  function fail(err: unknown) {
    pending.current = null;
    const failure = standingFailure(err, HIDE);
    if (failure === "hidden") { setShown(null); setError(null); }
    else setShown({ state: failure, ...NONE });
  }

  async function load(generation: number) {
    const read = ++reads.current;
    try {
      const allowances = await api.allowances(sessionId);
      if (generation !== lifetime.current || read !== reads.current) return;
      const { grants, unshown, nextEnd, pastEnds } = allowanceGrants(allowances, Date.now());
      const fresh = pastEnds.filter(end => !reconciled.current.has(end));
      pending.current = fresh.length === 0 ? null : { at: pending.current?.at ?? Date.now() + EXPIRY_GRACE_MS, ends: fresh };
      const reconcileAt = pending.current?.at ?? null;
      setShown(was => (was === null && grants.length === 0 && unshown === 0 ? null : { state: "ready", grants, unshown, nextEnd, reconcileAt }));
    } catch (err) {
      if (generation !== lifetime.current || read !== reads.current) return;
      fail(err);
    }
  }

  useEffect(() => {
    const generation = ++lifetime.current;
    reconciled.current = new Set();
    pending.current = null;
    setShown(null);
    setBusy(null);
    setError(null);
    void load(generation);
    const visible = () => { if (document.visibilityState === "visible") void load(generation); };
    document.addEventListener("visibilitychange", visible);
    const invalidate = () => { lifetime.current++; };
    return () => {
      invalidate();
      document.removeEventListener("visibilitychange", visible);
    };
    // `load` reads `api`, `sessionId` and the lifetime only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, api]);

  // A Gmail write in this chat has its result: an allowance may have been spent or granted.
  useEffect(() => {
    const grew = writes > seenWrites.current;
    seenWrites.current = writes;
    if (grew) void load(lifetime.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writes]);

  // Just after the earliest shown end still ahead. A read that answers the
  // same end re-arms nothing; an end that has passed by then is reconciled below.
  const nextEnd = shown?.state === "ready" ? shown.nextEnd : null;
  useEffect(() => {
    if (nextEnd === null) return;
    const generation = lifetime.current;
    const timer = setTimeout(() => void load(generation), Math.max(0, nextEnd - Date.now()) + EXPIRY_GRACE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextEnd]);

  // Once, just after the first answer that listed an end already past. If the
  // host still lists it after that read, its clock runs behind this device's:
  // nothing more is scheduled for that end, and the other reads remain.
  const reconcileAt = shown?.state === "ready" ? shown.reconcileAt : null;
  useEffect(() => {
    if (reconcileAt === null) return;
    const generation = lifetime.current;
    const timer = setTimeout(() => {
      for (const end of pending.current?.ends ?? []) reconciled.current.add(end);
      pending.current = null;
      void load(generation);
    }, Math.max(0, reconcileAt - Date.now()));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconcileAt]);

  async function revoke(cardId: string) {
    if (busy !== null) return;
    const generation = lifetime.current;
    setBusy(cardId);
    setError(null);
    try {
      const revoked = await api.revokeAllowance(sessionId, cardId);
      if (generation !== lifetime.current) return;
      if (revoked) setShown(was => was && { ...was, grants: was.grants.filter(grant => grant.id !== cardId) });
      await load(generation);
    } catch (err) {
      if (generation !== lifetime.current) return;
      if (standingFailure(err, HIDE) !== "failed") {
        // Newer than any read already sent: none of them may undo it. A read started after it still may.
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
    <div className="py-2" data-google-allowances-panel="">
      <GoogleAllowanceList
        state={shown.state}
        grants={shown.grants}
        unshown={shown.unshown}
        busy={busy}
        error={error}
        onRevoke={id => void revoke(id)}
        onRetry={retry}
      />
    </div>
  );
}
