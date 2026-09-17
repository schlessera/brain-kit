import { useBrainUiRoot } from "../../root-context.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity as ActivityIcon,
  AlertTriangle,
  RefreshCw,
  Timer,
} from "lucide-react";
import type { ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";

import type {
  ActivityIntent,
  ActivityRollups,
  ActivityRunSummary,
} from "../../lib/api-client.js";
import { useActivityStore } from "../../stores/activity-store.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { cn } from "../../lib/utils.js";
import { formatRelativeTime } from "../chat/tool-views.js";
import { RollupCards } from "./activity-rollups.js";
import { LiveRow, RunRow } from "./activity-run-list.js";
import { RunDetail } from "./activity-run-detail.js";
import { PushToggle } from "./push-toggle.js";
import { SettingsPanel } from "../settings/settings-panel.js";

/**
 * The Activity surface: an INDEX of all agent activity — live runs first,
 * then history — with cost/token rollups. Deliberately not a residence:
 * a session run deep-links back into its chat, a subagent into the drill-in
 * stack; only a cron run (which has no chat around it) details here.
 *
 * Live rows ride the index-view activity subscription while this surface is
 * open; history and rollups come from the REST activity API.
 */
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

  const inbox = useActivityStore((s) => s.inbox);
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
    void loadInbox();
  }, [api, loadInbox]);

  useEffect(() => {
    setRuns(null);
    setRollups(null);
    setError(null);
    setPricingStale(false);
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

  const liveRunIds = new Set(liveRoots.map((r) => r.runId));
  const restLive = (runs?.live ?? []).filter((r) => !liveRunIds.has(r.runId));
  const history = (runs?.history ?? []).filter((r) => !liveRunIds.has(r.runId));

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

  if (detailRunId) {
    return <RunDetail runId={detailRunId} onBack={() => showDetail(null)} />;
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {/* Hosted here like GraphPage does: the chat page (the usual host) is
          hidden while this view is active, so the staleness deep-link below
          needs its own panel mount. */}
      <SettingsPanel
        open={settingsPanelOpen}
        onClose={() => setSettingsPanelOpen(false)}
      />
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <ActivityIcon className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">Activity</h1>
        <div className="ml-auto flex items-center gap-2">
          {pricingStale && (
            <button
              type="button"
              onClick={() => openSettings("models")}
              className="flex items-center gap-1 rounded-md p-1.5 text-amber-500 transition-colors hover:bg-surface-raised hover:text-amber-400"
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

      <div className="mx-auto w-full max-w-3xl space-y-6 p-4">
        {error && (
          <p className="text-xs text-destructive">Could not load activity: {error}</p>
        )}

        {inbox.length > 0 && (
          <section>
            <div className="mb-2 flex items-center">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Needs attention
              </h2>
              <button
                type="button"
                onClick={() => void acknowledgeAllIntents()}
                className="ml-auto text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                Dismiss all
              </button>
            </div>
            <div className="space-y-1">
              {inbox.map((intent) => (
                <div
                  key={intent.id}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2 text-xs",
                    intent.kind === "failure"
                      ? "border-destructive/30 bg-destructive/5"
                      : "border-border-subtle bg-surface"
                  )}
                >
                  {intent.kind === "failure" ? (
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                  ) : intent.kind === "stuck" ? (
                    <Timer className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                  ) : (
                    <ActivityIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left hover:underline"
                    onClick={() => {
                      void acknowledgeIntent(intent.id);
                      openIntent(intent);
                    }}
                  >
                    {intent.title}
                  </button>
                  <span className="shrink-0 text-[10px] text-muted-foreground/60">
                    {formatRelativeTime(intent.createdAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void acknowledgeIntent(intent.id)}
                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                    aria-label="Dismiss"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {rollups && <RollupCards rollups={rollups} />}

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

        <section>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            History
          </h2>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground/70">No recorded runs yet.</p>
          ) : (
            <div className="space-y-1">
              {history.map((run) => (
                <RunRow key={run.runId} run={run} onOpen={openRun} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
