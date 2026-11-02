import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Callout, ListRow, Placeholder } from "@schlessera/brain-ui-kit";
import type { ApifyGrantRead, ApifyPolicyChange, ApifyPolicyMode, ApifySettingsRead } from "@schlessera/brain-ui-sdk/protocol";
import type { PolicyChangeReview } from "@schlessera/brain-ui-sdk/tool-contracts";
import { useBrainUiRoot } from "../../root-context.js";
import { ApiRequestError } from "../../lib/api-client.js";
import { rememberFileEntry } from "../../lib/file-entry-focus.js";
import { MODE_LABELS, providerCard } from "../../lib/apify.js";
import { takeApifyFocus } from "../../lib/apify-focus.js";
import { ApifyView, type ApifyEdit, type ApifyFocusTarget } from "./apify-view.js";

/** How often an open section re-reads the host, so a change made on another device shows up. */
export const APIFY_SETTINGS_REFRESH_MS = 30_000;

/**
 * The Apify section's container (S6): the load, the owner/root lifetime
 * guards, and every policy edit (#3163, R2 A).
 *
 * An edit never changes a control locally. Choosing a value proposes it
 * through the existing policy-change review; the control keeps the host's
 * value until the host reports the approved write, and a refused review
 * leaves it where it was. A lost answer is unconfirmed: "Check again" reads
 * the same request and never sends the answer twice.
 *
 * `layout="row"` renders only the phone drill-in row; `inline` and `detail`
 * render the whole section.
 */
export function ApifySection({ active, layout = "inline", onOpen, onPresence }: {
  active: boolean;
  layout?: "inline" | "detail" | "row";
  onOpen?: () => void;
  onPresence?: (present: boolean | null) => void;
}) {
  const root = useBrainUiRoot();
  const api = root.api;
  const [read, setRead] = useState<ApifySettingsRead | null>(null);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState<ApifyEdit | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [stale, setStale] = useState(false);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0), owner = useRef(root.authLock.epoch());
  const editRef = useRef<ApifyEdit | null>(null);
  const lastHash = useRef<string | null | undefined>(undefined);
  /** The hash this section's own approved write produced; not "another device". */
  const ownHash = useRef<string | null>(null);
  const returnFocus = useRef<(() => void) | null>(null);
  const focusReview = useRef(false);
  const container = useRef<HTMLDivElement>(null);
  const headings = {
    provider: useRef<HTMLHeadingElement>(null), discovery: useRef<HTMLHeadingElement>(null), actors: useRef<HTMLHeadingElement>(null),
    grants: useRef<HTMLHeadingElement>(null), limits: useRef<HTMLHeadingElement>(null), today: useRef<HTMLHeadingElement>(null),
  } satisfies Record<ApifyFocusTarget, React.RefObject<HTMLHeadingElement | null>>;
  const wantFocus = useRef<ApifyFocusTarget | undefined>(undefined);

  /** Every continuation checks it still belongs to this root, owner and load. */
  const current = useCallback((token: number) => token === generation.current && owner.current === root.authLock.epoch(), [root]);
  const announce = (text: string) => setAnnouncement(value => value === text ? `${text} ` : text);
  const setEditBoth = (next: ApifyEdit | null) => { editRef.current = next; setEdit(next); };

  const load = useCallback(async (options: { refresh?: boolean; quiet?: boolean } = {}) => {
    const token = generation.current;
    try {
      const next = await api.apify({ refresh: options.refresh });
      if (!current(token)) return;
      const previous = lastHash.current;
      lastHash.current = next.policy.hash;
      if (previous !== undefined && previous !== next.policy.hash && editRef.current === null && next.policy.hash !== ownHash.current)
        announce("Changed on another device.");
      setRead(next); setError(""); setStale(false);
      onPresence?.(true);
    } catch (err) {
      if (!current(token)) return;
      if (err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) { setRead(null); onPresence?.(false); return; }
      if (options.quiet) { setStale(true); return; }
      setError("Apify settings didn't load. Nothing has changed.");
      onPresence?.(true);
    }
  }, [api, current, onPresence]);

  useEffect(() => {
    generation.current++; owner.current = root.authLock.epoch();
    // A new root or owner: clear the old owner's private display and drop late replies.
    setRead(null); setError(""); setEditBoth(null); setAnnouncement(""); setStale(false); setChecking(false);
    lastHash.current = undefined; ownHash.current = null; returnFocus.current = null;
    onPresence?.(null);
    if (!active) return;
    if (layout !== "row") wantFocus.current = takeApifyFocus(root);
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load({ quiet: true }); };
    const timer = setInterval(refresh, APIFY_SETTINGS_REFRESH_MS);
    window.addEventListener("focus", refresh);
    // Sign-out or an owner change: drop the old owner's account, grants and spend at once, and every late reply with them.
    const unwatch = root.authLock.state.subscribe(state => {
      if (state.phase !== "active") { generation.current++; setRead(null); setEditBoth(null); setAnnouncement(""); lastHash.current = undefined; return; }
      if (owner.current !== root.authLock.epoch()) { generation.current++; owner.current = root.authLock.epoch(); void load(); }
    });
    const invalidate = () => { generation.current++; clearInterval(timer); window.removeEventListener("focus", refresh); unwatch(); };
    return invalidate;
  }, [active, root, load, layout, onPresence]);

  // Focus a "Why" link's target once the facts are on screen.
  useLayoutEffect(() => {
    if (!read || !wantFocus.current) return;
    const target = wantFocus.current; wantFocus.current = undefined;
    (headings[target].current ?? headings.provider.current)?.focus();
  });
  // Move focus into a review when it appears; return it after the outcome.
  useLayoutEffect(() => {
    if (focusReview.current && edit?.phase === "review") {
      focusReview.current = false;
      container.current?.querySelector<HTMLElement>("[data-apify-review]")?.focus();
    }
  }, [edit]);

  // Focus returns in the commit that shows the host's new state, never to a control about to disappear.
  const [focusTick, setFocusTick] = useState(0);
  const restoring = useRef<(() => void) | null>(null);
  const restore = () => { restoring.current = returnFocus.current; returnFocus.current = null; setFocusTick(tick => tick + 1); };
  useLayoutEffect(() => {
    const back = restoring.current;
    if (!back || editRef.current) return;
    restoring.current = null;
    back();
  }, [focusTick]);

  function settle(review: PolicyChangeReview, label: string) {
    if (review.state === "updated") {
      ownHash.current = review.proposedHash;
      setEditBoth(null); announce(`Changed: ${label}.`); void load().then(restore);
    } else if (review.state === "pending" || review.state === "writing" || review.state === "unknown") {
      setEditBoth(editRef.current && { ...editRef.current, phase: "unconfirmed" });
      announce("Not confirmed yet. The setting shows what the host last reported.");
    } else {
      setEditBoth(null); announce(`Unchanged: ${review.message}`); void load().then(restore);
    }
  }

  async function propose(target: string, label: string, change: ApifyPolicyChange, back: () => void) {
    if (!read || editRef.current) return;
    const token = generation.current;
    returnFocus.current = back;
    setEditBoth({ target, label, phase: "proposing" });
    try {
      const proposal = await api.apifyPolicyPropose(change, read.policy.hash);
      if (!current(token)) return;
      focusReview.current = true;
      setEditBoth({ target, label, phase: "review", proposal });
    } catch (err) {
      if (!current(token)) return;
      setEditBoth(null);
      announce(`Unchanged: ${err instanceof Error ? err.message : "the change couldn't be proposed."}`);
      void load().then(restore);
    }
  }

  async function answer(approve: boolean) {
    const pending = editRef.current;
    if (!pending?.proposal || pending.phase !== "review") return;
    const token = generation.current;
    setEditBoth({ ...pending, phase: "deciding" });
    try {
      const review = await api.apifyPolicyDecide(pending.proposal.turn_id, pending.proposal.request_id, approve);
      if (!current(token)) return;
      settle(review, pending.label);
    } catch (err) {
      if (!current(token)) return;
      // A definitive refusal of the answer is an outcome; a lost or failed reply is not.
      if (err instanceof ApiRequestError && err.status >= 400 && err.status < 500) {
        setEditBoth(null); announce(`Unchanged: ${err.message}`); void load().then(restore); return;
      }
      setEditBoth({ ...pending, phase: "unconfirmed" });
      announce("Not confirmed yet. The setting shows what the host last reported.");
      void reconcile(pending, token);
    }
  }

  /** Read the same request's receipt. Never repeats the answer. */
  async function reconcile(pending: ApifyEdit, token = generation.current) {
    if (!pending.proposal) return;
    try {
      const review = await api.policyProposal(pending.proposal.turn_id, pending.proposal.request_id, null);
      if (!current(token)) return;
      if (review.state === "pending") return; // The answer never arrived; it is not sent again.
      settle(review, pending.label);
    } catch { /* Still unconfirmed; Check again reads it. */ }
    if (current(token)) void load({ quiet: true });
  }

  function focusIn(selector: string, fallback: () => HTMLElement | null) {
    return () => (container.current?.querySelector<HTMLElement>(selector) ?? fallback())?.focus();
  }

  if (layout === "row") {
    const card = read && providerCard(read);
    if (!active) return null;
    // The row exists while loading, so Back can return focus to it at once.
    return <div data-apify-drill className="[&_[role=button]]:min-h-11">
      <ListRow variant="card" icon="wallet" title="Apify" subtitle="Paid web extraction" value={card ? card.label : error ? "Couldn't load" : "Checking…"} chevron onClick={onOpen} />
    </div>;
  }
  if (!active) return null;
  if (error && !read) return <div role="alert" className="space-y-2"><Callout tone="gold" variant="banner" icon="failed" text={error} /></div>;
  if (!read) return <Placeholder variant="loading" lines={3} />;

  return <div ref={container} className="min-w-0">
    {error && <Callout tone="gold" variant="banner" text={error} />}
    <ApifyView read={read} edit={edit} announcement={announcement} stale={stale} checking={checking} headings={headings}
      onTurn={enabled => propose("enabled", enabled ? "Apify is on" : "Apify is off", { enabled },
        focusIn('[data-apify-settings] section[aria-labelledby="apify-provider-heading"] [role="button"]', () => headings.provider.current))}
      onMode={(field, mode: ApifyPolicyMode) => propose(field, `${field === "discovery" ? "Catalog search" : "Running Actors"} is ${MODE_LABELS[mode]}`, { [field]: mode } as ApifyPolicyChange,
        focusIn(`[data-apify-mode="${field}"] [role="radio"][aria-checked="true"]`, () => headings[field].current))}
      onRevoke={(grant: ApifyGrantRead, index: number) => propose(`grant:${index}`, `${grant.actor_id} build ${grant.build_number} revoked`,
        { remove_grant: { account_id: grant.account_id, actor_id: grant.actor_id, build_number: grant.build_number, profile_id: grant.profile_id, expires_at: grant.expires_at } },
        () => { const rows = container.current?.querySelectorAll<HTMLElement>("[data-apify-grant] [role=\"button\"]"); (rows?.[index] ?? rows?.[index - 1] ?? headings.grants.current)?.focus(); })}
      onCheck={async () => { const token = generation.current; setChecking(true); await load({ refresh: true }); if (current(token)) { setChecking(false); announce("Checked with Apify."); } }}
      onConfirmAccount={async () => {
        const token = generation.current, account = read.pending_account;
        if (!account) return;
        try { await api.apifyConfirmAccount(account.id); if (current(token)) { announce(`Now using ${account.username ?? account.id}.`); void load(); } }
        catch (err) { if (current(token)) { announce(`Unchanged: ${err instanceof Error ? err.message : "the account couldn't be confirmed."}`); void load(); } }
      }}
      onReview={() => headings.grants.current?.focus()}
      onOpenPolicy={opener => {
        if (owner.current !== root.authLock.epoch()) return;
        rememberFileEntry(root, opener, opener.matches(":focus-visible"));
        root.stores.ui.getState().openPanel("files"); void root.stores.file.getState().openFile(read.policy.path);
      }}
      onOpenActivity={() => root.stores.ui.getState().setActiveView("activity")}
      onApprove={() => void answer(true)} onDecline={() => void answer(false)}
      onCheckProposal={() => { const pending = editRef.current; if (pending) void reconcile(pending); }} />
  </div>;
}
