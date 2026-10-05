import { useBrainUiRoot } from "../../root-context.js";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Activity as ActivityIcon, AlertTriangle, RefreshCw } from "lucide-react";
import type { ActivitySpan, SystemStatus } from "@schlessera/brain-ui-sdk/protocol";

import type {
  ActivityIntent,
  ActivityRollups,
  ActivityRunSummary,
} from "../../lib/api-client.js";
import { useActivityStore } from "../../stores/activity-store.js";
import { useChatStore, pendingApprovals } from "../../stores/chat-store.js";
import { EmptyState, FilterRow, InlineToast, Label } from "@schlessera/brain-ui-kit";
import { cn } from "../../lib/utils.js";
import { ApprovalCard, approvalOutcome } from "./approval-card.js";
import { useUIStore } from "../../stores/ui-store.js";
import { formatRelativeTime } from "../chat/tool-views.js";
import { RollupCards } from "./activity-rollups.js";
import { LiveRow, RunRow } from "./activity-run-list.js";
import { RunDetail, RunTraceSteps } from "./activity-run-detail.js";
import { IntentCard } from "./activity-views.js";
import { focusAfterDecision, singleKey } from "../../lib/single-key.js";
import { useFinePointer } from "../../hooks/use-fine-pointer.js";
import { PushToggle } from "./push-toggle.js";
import { ActivityReportSheet, type ActivityReportRequest } from "./activity-report.js";
import { SettingsPanel } from "../settings/settings-panel.js";

/**
 * The Actions surface (D37): one queue, three lenses — `needs you` (pending
 * approvals from every transcript, then the inbox), `running` (live runs),
 * `done` (history and the rollups). "What needs me" and "what has been
 * happening" are two lenses on one queue, so the rail has one destination
 * and this page has a filter. Deliberately not a residence: a session run
 * deep-links back into its chat, a subagent into the drill-in stack; only a
 * cron run (which has no chat around it) details here.
 *
 * Live rows ride the index-view activity subscription while this surface is
 * open; history and rollups come from the REST activity API. The hash stays
 * `#/activity` — the route is a contract with push notifications.
 *
 * Panes (D4): below `laptop:` the run detail replaces the queue, as on the
 * phone. From `laptop:` the queue is a 360px list column beside the detail
 * pane, and from `wide:` a 300px evidence rail on the right carries the
 * run's trace and the last decision's receipt. Each pane scrolls on its own.
 * The detail is one element at every width — the list hides under it below
 * `laptop:` — so a deep link selects the same run everywhere.
 */
export type ActionsLens = "needs-you" | "running" | "done";
export function ActivityPage() {
  const root = useBrainUiRoot();
  const api = root.api;
  const request = useRef(0);
  const supported = useActivityStore((s) => s.supported);
  const connectionEpoch = useActivityStore((s) => s.connectionEpoch);
  const liveSpans = useActivityStore((s) => s.spans);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const openSettings = useUIStore((s) => s.openSettings);
  const settingsPanelOpen = useUIStore((s) => s.settingsPanelOpen);
  const setSettingsPanelOpen = useUIStore((s) => s.setSettingsPanelOpen);
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  const [runs, setRuns] = useState<{ live: ActivityRunSummary[]; history: ActivityRunSummary[] } | null>(null);
  const [rollups, setRollups] = useState<ActivityRollups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const [pricingStale, setPricingStale] = useState(false);
  /** `/api/status`'s software identity for bug reports; null until loaded or when refused. */
  const [software, setSoftware] = useState<SystemStatus["software"] | null>(null);
  const [report, setReport] = useState<ActivityReportRequest | null>(null);

  const inbox = useActivityStore((s) => s.inbox);
  // Derived from the buffer references, not selected as a fresh array: a
  // selector returning a new array every call re-renders without end.
  const buffers = useChatStore((s) => s.buffers);
  const draft = useChatStore((s) => s.draft);
  const approvals = useMemo(() => pendingApprovals({ buffers, draft }), [buffers, draft]);
  const resolveToolApproval = useChatStore((s) => s.resolveToolApproval);
  /**
   * The lens the reader picked, or — until they pick one — the one that has
   * something in it: what needs you, else what is running, else what is
   * done. A page that opens on an empty "needs you" when a run is live would
   * be reassurance in the wrong place.
   */
  const [picked, setLens] = useState<ActionsLens | null>(null);
  /**
   * The receipt for the last DECISION — Allowed, Always allowed, Denied —
   * shown above the `EmptyState` that replaces a drained section (D37) and
   * in the evidence rail: a keyboard user is told "that is done" instead of
   * being dropped at the document top. A decision earns a toast by the
   * sixth pass's own criterion (§4: "a toast is for effects you can take
   * back or that happen out of sight"): its effect happens in the run, out
   * of sight, and the card leaving says nothing about what the run did
   * with the answer.
   *
   * A DISMISSAL sets no receipt. Acknowledging an inbox item is neither —
   * it cannot be taken back (the activity API has no un-acknowledge) and
   * the row vanishing under the cursor is the whole effect. An `InlineToast`
   * whose point is Undo, shipped without Undo, "teaches that the kit's
   * receipts are decorative"; so until un-acknowledge exists, dismissal is
   * silent and the row leaving the list is the receipt. Grow un-acknowledge
   * and the toast returns with its Undo.
   */
  const [receipt, setReceipt] = useState<{ text: string; target: string; effect: string } | null>(null);
  const [drained, setDrained] = useState(false);
  const loadInbox = useActivityStore((s) => s.loadInbox);
  const acknowledgeIntent = useActivityStore((s) => s.acknowledgeIntent);
  const acknowledgeAllIntents = useActivityStore((s) => s.acknowledgeAllIntents);

  const refresh = useCallback(() => {
    const token = ++request.current;
    const current = () => token === request.current;
    setError(null);
    api.activityRuns({ limit: 100 })
      .then((runs) => { if (current()) setRuns(runs); })
      .catch((err) => { if (current()) setError(err instanceof Error ? err.message : String(err)); });
    api.activityRollups(7)
      .then((rollups) => { if (current()) setRollups(rollups); })
      .catch(() => {});
    // A stale table is only a warning while refreshes are failing. Older
    // servers have no pricing route, so a rejection remains a quiet state.
    api.pricingState()
      .then((s) => { if (current()) setPricingStale(Boolean(s.stale && s.error)); })
      .catch(() => { if (current()) setPricingStale(false); });
    // Read here, never when a report opens: a report names the server's
    // release and commit only when this authorized read already succeeded.
    api.status()
      .then((s) => {
        if (!current()) return;
        const sw = s.software;
        setSoftware(sw && typeof sw.release === "string" && typeof sw.sourceCommit === "string" ? sw : null);
      })
      .catch(() => { if (current()) setSoftware(null); });
    void loadInbox();
  }, [api, loadInbox]);

  useEffect(() => {
    setRuns(null);
    setRollups(null);
    setError(null);
    setPricingStale(false);
    setSoftware(null);
    setReport(null);
    seenLive.current.clear();
    promoted.current.clear();
    setDetailRunId(null);
  }, [root]);

  // Reconnects heal the REST snapshot and establish a new subscription.
  // Cleanup also invalidates responses from the old root or request generation.
  useEffect(() => {
    refresh();
    if (supported) root.connection.send({ type: "activity_subscribe", view: "index" });
    const invalidate = () => { request.current++; };
    return () => {
      invalidate();
      if (supported) root.connection.send({ type: "activity_unsubscribe", view: "index" });
    };
  }, [supported, connectionEpoch, root, refresh]);

  // Deep-link consumer: `#/activity/<runId>` (the push notification landing
  // spot — the shell routes it here but leaves the hash intact) opens that
  // run's detail. Opening/closing detail writes the hash back via
  // history.replaceState so the link stays shareable without history spam.
  useEffect(() => {
    const applyHash = () => {
      const match = /^#\/activity\/(.+)$/.exec(window.location.hash);
      if (match) setDetailRunId(decodeURIComponent(match[1]!));
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  function showDetail(runId: string | null) {
    setDetailRunId(runId);
    const target = runId ? `#/activity/${encodeURIComponent(runId)}` : "#/activity";
    if (window.location.hash !== target) {
      // window-qualified: `history` is the run list in this scope.
      window.history.replaceState(null, "", target);
    }
  }

  // Live open roots from the stream override/extend the REST snapshot.
  const liveRoots = useMemo(() => {
    const roots: ActivitySpan[] = [];
    for (const byId of Object.values(liveSpans)) {
      for (const span of Object.values(byId)) {
        if (!span.parentSpanId && span.outcome === undefined) roots.push(span);
      }
    }
    return roots.sort((a, b) => b.startedAt - a.startedAt);
  }, [liveSpans]);

  // A run seen running on this page that has since ended moves to history
  // with its streamed outcome, so a failure offers Send bug report without a
  // reload. Older terminal runs the mirror holds for other views are not
  // promoted: only the ones this page watched end.
  const seenLive = useRef(new Set<string>());
  for (const r of liveRoots) seenLive.current.add(r.runId);
  for (const r of runs?.live ?? []) seenLive.current.add(r.runId);
  // Kept apart from the bounded mirror, which may evict a finished run's
  // spans before the next REST refresh lists it.
  const promoted = useRef(new Map<string, ActivityRunSummary>());
  for (const runId of seenLive.current) {
    const root = Object.values(liveSpans[runId] ?? {}).find((s) => !s.parentSpanId);
    if (root && root.outcome !== undefined && root.outcome !== null) {
      promoted.current.set(runId, settledSummary(root, runs?.live.find((r) => r.runId === runId)));
    }
  }
  const settled = promoted.current;

  const liveRunIds = new Set(liveRoots.map((r) => r.runId));
  const restLive = (runs?.live ?? []).filter((r) => !liveRunIds.has(r.runId) && !settled.has(r.runId));
  const restHistory = (runs?.history ?? []).filter((r) => !liveRunIds.has(r.runId));
  const known = new Set([...restHistory.map((r) => r.runId)]);
  const ended = [...settled.values()].filter((row) => !known.has(row.runId) && !liveRunIds.has(row.runId));
  // Newest first, as the API orders history; a promoted run that started
  // before rows already listed takes its place among them, not the top.
  const history = [...ended, ...restHistory].sort((a, b) => b.startedAt - a.startedAt);

  function openRun(row: {
    runId: string;
    origin: string;
    sessionId?: string | null;
    running?: boolean;
  }) {
    if (row.origin === "session" && row.sessionId) {
      // Chat is the residence — a session run opens its session.
      setActiveSession(row.sessionId);
      setActiveView("chat");
      return;
    }
    showDetail(row.runId);
  }

  /** An inbox tap routes like any run row: chat for session runs, detail otherwise. */
  function openIntent(intent: ActivityIntent) {
    const liveRoot = liveRoots.find((r) => r.runId === intent.runId);
    if (liveRoot) {
      openRun({ runId: liveRoot.runId, origin: liveRoot.origin, sessionId: liveRoot.sessionId });
      return;
    }
    const known = [...(runs?.live ?? []), ...(runs?.history ?? [])].find(
      (r) => r.runId === intent.runId
    );
    if (known) {
      openRun(known);
    } else {
      showDetail(intent.runId);
    }
  }

  const keys = useUIStore((s) => s.singleKeyShortcuts);
  // The keys bind on `keys` alone; they are PRINTED only while a mouse or
  // trackpad is present (#86, #100), like the approval card's caps. A
  // touch-only tablet past `laptop:` would otherwise read keys it cannot fire.
  const finePointer = useFinePointer();
  const printKeys = keys && finePointer;
  const INTENT_CARD = "[data-intent-card] > [role=\"button\"]";
  /**
   * `j` / `k` move inside the focused list and `d` dismisses the focused
   * card (D36): all three act only while a card in this list holds focus,
   * and the footer prints them. After a dismiss, focus goes to the next
   * card, else the previous, else the page heading.
   */
  function onInboxKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!keys) return;
    const key = singleKey(event);
    if (key !== "j" && key !== "k" && key !== "d") return;
    const cards = [...event.currentTarget.querySelectorAll<HTMLElement>(INTENT_CARD)];
    const here = cards.findIndex((card) => card.contains(event.target as Node));
    if (here === -1) return;
    event.preventDefault();
    if (key === "d") {
      const intent = inbox[here];
      focusAfterDecision(cards[here]!, INTENT_CARD, "[data-needs-you-heading]");
      if (intent) dismiss(intent);
      return;
    }
    cards[(here + (key === "j" ? 1 : -1) + cards.length) % cards.length]?.focus();
  }

  /** Silent by rule (see `receipt`): the row leaving is the receipt. `drained`
   * still flips so the empty state's heading takes focus after the last one. */
  function dismiss(intent: ActivityIntent) {
    setDrained(inbox.length + approvals.length <= 1);
    void acknowledgeIntent(intent.id);
  }
  function dismissAll() {
    setDrained(approvals.length === 0);
    void acknowledgeAllIntents();
  }
  function decideApproval(key: string | null, toolUseId: string, approved: boolean, asked?: boolean) {
    const tool = approvals.find((a) => a.tool.id === toolUseId)?.tool;
    const { receipt, frame } = approvalOutcome(tool, toolUseId, approved, asked);
    setReceipt(receipt);
    setDrained(inbox.length + approvals.length <= 1);
    resolveToolApproval(key, toolUseId, approved);
    root.connection.send(frame);
  }
  const needsYouCount = inbox.length + approvals.length;
  const runningCount = liveRoots.length + restLive.length;
  const lens: ActionsLens = picked ?? (needsYouCount > 0 || drained ? "needs-you" : runningCount > 0 ? "running" : "done");

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col laptop:flex-row">
      {/* Hosted here like GraphPage does: the chat page (the usual host) is
          hidden while this view is active, so the staleness deep-link below
          needs its own panel mount. */}
      <SettingsPanel
        open={settingsPanelOpen}
        onClose={() => setSettingsPanelOpen(false)}
      />
      {/* The list column. Below `laptop:` it is the whole page and an open
          detail replaces it; from `laptop:` it is 360px beside the detail. */}
      <section
        aria-label="Actions queue"
        className={cn(
          "min-h-0 flex-col overflow-y-auto laptop:flex laptop:w-[360px] laptop:flex-none laptop:border-r laptop:border-border-subtle",
          detailRunId ? "hidden" : "flex flex-1"
        )}
      >
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
          <ActivityIcon className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-medium outline-none" tabIndex={-1} data-activity-heading="">Actions</h1>
          <div className="ml-auto flex items-center gap-2">
            {pricingStale && (
              <button
                type="button"
                onClick={() => openSettings("models")}
                className="flex items-center gap-1 rounded-md p-1.5 text-primary transition-colors hover:bg-surface-raised hover:text-primary/80"
                aria-label="Pricing refresh is failing — costs may use stale rates. Open Settings"
                title="Pricing refresh is failing — costs may use stale rates. Open Settings"
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="hidden text-[10px] sm:inline">Pricing stale</span>
              </button>
            )}
            <PushToggle />
          </div>
          <button
            type="button"
            onClick={refresh}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground"
            aria-label="Refresh"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mx-auto w-full max-w-3xl space-y-6 p-4 laptop:max-w-none">
          {error && (
            <p className="text-xs text-destructive">Could not load activity: {error}</p>
          )}

          <FilterRow
            items={[
              { label: `needs you ${needsYouCount}`, onClick: () => setLens("needs-you") },
              { label: `running ${runningCount}`, onClick: () => setLens("running") },
              { label: `done ${history.length}`, onClick: () => setLens("done") },
            ]}
            active={lens === "needs-you" ? 0 : lens === "running" ? 1 : 2}
          />

          {lens === "needs-you" && (
            <section aria-labelledby="needs-you-heading">
              <div className="mb-2 flex items-center">
                <h2 id="needs-you-heading" className="text-xs font-medium uppercase tracking-wide text-muted-foreground outline-none" tabIndex={-1} data-needs-you-heading="">
                  Needs you
                </h2>
                {inbox.length > 0 && (
                  <button
                    type="button"
                    onClick={dismissAll}
                    className="ml-auto text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Dismiss all
                  </button>
                )}
              </div>
              {needsYouCount === 0 ? (
                <div className="flex flex-col gap-3">
                  {receipt && <InlineToast text={receipt.text} target={receipt.target} effect={receipt.effect} tone="teal" undoLabel="" />}
                  {/* A drained section becomes the empty state, and its heading
                      takes focus after the last decision (D37) — never the
                      document top. */}
                  <EmptyState variant="caught_up" meta="" focusTitle={drained} />
                </div>
              ) : (
                <>
                  {approvals.length > 0 && (
                    <div className="mb-3 space-y-2">
                      {approvals.map(({ key, tool }) => (
                        <ApprovalCard
                          key={tool.id}
                          tool={tool}
                          origin={key ? `session ${key.slice(0, 8)}` : "this conversation"}
                          keys={keys}
                          onDecide={(approved, always) => decideApproval(key, tool.id, approved, always)}
                        />
                      ))}
                    </div>
                  )}
                  <div className="space-y-2" onKeyDown={onInboxKeyDown}>
                    {inbox.map((intent) => (
                      <div key={intent.id} data-intent-card="">
                        <IntentCard
                          intent={intent}
                          when={formatRelativeTime(intent.createdAt)}
                          keyHint={printKeys}
                          onOpen={() => {
                            void acknowledgeIntent(intent.id);
                            openIntent(intent);
                          }}
                          onDismiss={() => dismiss(intent)}
                        />
                      </div>
                    ))}
                  </div>
                  {printKeys && (
                    <p className="mt-1.5 font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/70 laptop:hidden">
                      j / k move · d dismiss · ⏎ open{approvals.length > 0 ? " · a allow" : ""}
                    </p>
                  )}
                </>
              )}
            </section>
          )}

          {lens === "running" && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Running now
              </h2>
              {liveRoots.length === 0 && restLive.length === 0 ? (
                <p className="text-xs text-muted-foreground/70">Nothing is running.</p>
              ) : (
                <div className="space-y-1">
                  {liveRoots.map((span) => (
                    <LiveRow key={span.runId} span={span} onOpen={openRun} />
                  ))}
                  {restLive.map((run) => (
                    <RunRow key={run.runId} run={run} onOpen={openRun} />
                  ))}
                </div>
              )}
            </section>
          )}

          {lens === "done" && (
            <>
              {rollups && <RollupCards rollups={rollups} />}
              <section>
                <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground outline-none" tabIndex={-1} data-history-heading="">
                  History
                </h2>
                {history.length === 0 ? (
                  <p className="text-xs text-muted-foreground/70">No recorded runs yet.</p>
                ) : (
                  <div className="space-y-1">
                    {history.map((run) => (
                      <RunRow key={run.runId} run={run} onOpen={openRun} onReport={(row) => setReport({ runId: row.runId, run: row, from: "row" })} />
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
        {/* The column's footer (D4): the printed keys, pinned under the list
            from `laptop:`. Only while the keys can fire — they act inside the
            inbox list — so a lens without cards advertises nothing, and
            only with a fine pointer (#100). */}
        {printKeys && lens === "needs-you" && inbox.length > 0 && (
          <p className="sticky bottom-0 mt-auto hidden border-t border-border-subtle bg-background px-4 py-2 font-[family-name:var(--font-mono)] text-[10px] text-muted-foreground/70 laptop:block">
            j / k move · d dismiss
          </p>
        )}
      </section>

      {/* The detail pane. Below `laptop:` it shows only with a selection and
          takes the whole page; from `laptop:` it is always there, holding the
          selected run or the prompt to pick one. */}
      <div className={cn("min-h-0 min-w-0 flex-1 flex-col", detailRunId ? "flex" : "hidden laptop:flex")}>
        {detailRunId ? (
          <RunDetail runId={detailRunId} onBack={() => showDetail(null)} embedded onReport={setReport} />
        ) : (
          <div className="flex h-full items-center justify-center overflow-y-auto p-4">
            <EmptyState
              variant="quiet"
              title="Pick a run"
              body="Its trace, attempts and what it was holding show here."
              meta=""
              minHeight={0}
            />
          </div>
        )}
      </div>

      {report && <ActivityReportSheet request={report} server={software} onClose={() => setReport(null)} />}

      {/* The evidence rail, `wide:` only: the run's trace as a record, and
          the receipt for the last decision made on this page. */}
      {detailRunId && (
        <aside
          aria-label="Run evidence"
          className="hidden min-h-0 w-[300px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border-subtle bg-surface p-4 wide:flex"
        >
          <div className="flex flex-col gap-2">
            <Label text="Trace" icon="steps" meta="this run" />
            <RunTraceSteps runId={detailRunId} />
          </div>
          {receipt && (
            <div className="flex flex-col gap-2">
              <Label text="Last decision" icon="resolved" />
              <InlineToast text={receipt.text} target={receipt.target} effect={receipt.effect} tone="teal" undoLabel="" />
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

/** A run this page watched end, as a history row until the next REST refresh. */
function settledSummary(root: ActivitySpan, rest: ActivityRunSummary | undefined): ActivityRunSummary {
  const endedAt = root.endedAt ?? null;
  return {
    ...(rest ?? {
      name: root.name,
      sessionId: root.sessionId ?? null,
      jobName: root.jobName ?? null,
      costUsd: null,
      failureReason: null,
      detailPruned: false,
    }),
    runId: root.runId,
    origin: root.origin,
    startedAt: rest?.startedAt ?? root.startedAt,
    endedAt,
    outcome: root.outcome ?? null,
    running: false,
    durationMs: endedAt !== null ? endedAt - root.startedAt : null,
    failureReason: rest?.failureReason ?? root.outcomeReason ?? null,
  };
}
