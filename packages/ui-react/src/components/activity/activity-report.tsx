import { useEffect, useMemo, useState } from "react";
import { Flag } from "lucide-react";
import { Disclosure } from "@schlessera/brain-ui-kit";
import type { SystemStatus } from "@schlessera/brain-ui-sdk/protocol";

import { ApiRequestError, type ActivityRunRollup } from "../../lib/api-client.js";
import {
  activityReportBody,
  activityReportTitle,
  failureReasonInclusion,
  jobNameInclusion,
  type ReportRecord,
  type ReportRun,
} from "../../lib/activity-report.js";
import { useBrainUiRoot } from "../../root-context.js";
import { CLIENT_RELEASE } from "../chat/stats/software.js";
import { cn } from "../../lib/utils.js";
import { DiagnosticReview, type ReviewCopy } from "../report/diagnostic-review.js";

/**
 * Send bug report for a failed activity (#598): the row's sibling control,
 * the detail's button, and the review sheet both open. The sheet is #576's
 * shared `DiagnosticReview` with an editable title, the allowlisted facts of
 * `lib/activity-report.ts`, and explicit, capped inclusions. Opening or
 * closing it makes no request beyond, from a row, one read of this run's own
 * record from this server without payloads. The run is never changed.
 */

export const ACTIVITY_REVIEW_COPY: ReviewCopy = {
  reportSubtitle: "Opening the issue sends this text to GitHub before you submit it. The issue will be public at github.com/schlessera/brain-kit.",
  copySubtitle: "Review and edit this text. Copy places it on your clipboard only when you choose Copy.",
  footnote: (
    <>
      <p className="mb-2">Left out by default: raw trace and events, failure text, job name, paths, hostnames, credentials, IDs, conversation and tool payloads.</p>
      {/* The kit summary is one text line tall; D34 wants a 44px target here. */}
      <div className="[&_[role=button]]:min-h-11">
        <Disclosure label="What's left out and why">
          <div className="space-y-1 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Not included unless you add it yourself:</p>
            <ul className="list-disc space-y-1 pl-4">
              <li><b>Raw trace and events.</b> They can hold your notes, file contents, conversation text and tool inputs and outputs.</li>
              <li><b>The failure reason and other provider or tool messages.</b> These are arbitrary text, and can quote paths, hostnames, account details or credentials.</li>
              <li><b>Job and run names.</b> Jobs you define can name private projects or people.</li>
              <li><b>File paths, hostnames, URLs and credentials</b> of any kind.</li>
              <li><b>Principal, session and run IDs.</b> They identify this server's records and sign-ins.</li>
              <li><b>Conversation text and tool payloads.</b></li>
            </ul>
            <p>The app removes what it can recognize, but it can't promise to catch everything. Read the text above before you send it. The issue will be public.</p>
          </div>
        </Disclosure>
      </div>
    </>
  ),
  opened: "GitHub's new-issue form was opened with this text in a new tab. The issue isn't filed until you submit it on GitHub. If no tab opened, copy the text and paste it into a new issue.",
  openFailed: "Couldn't open the issue form. Copy the text and paste it into a new issue on GitHub.",
  tooLong: "This report is too long for the issue link. Copy it and paste it into a new issue on GitHub, or shorten it.",
  copied: "Copied the reviewed text.",
  copyFailed: "Couldn't copy. The text is selected; copy it manually.",
};

/** The socket is down, or the browser says it has no network. */
function isOffline(wsStatus: string): boolean {
  return wsStatus !== "connected" || (typeof navigator !== "undefined" && navigator.onLine === false);
}

export const OFFLINE_NOTE = "You appear to be offline. Copy works now; the GitHub link needs a connection.";

/** One report request: the run, and its record when the opener already holds it. */
export interface ActivityReportRequest {
  runId: string;
  run: ReportRun;
  /** Absent from a history row: the sheet reads the run's record itself. */
  record?: ReportRecord;
  /** Where focus goes when the opener has re-rendered away. */
  from: "row" | "detail";
}

/** The accessible name, the same at every width. */
export function reportButtonName(title: string, outcome: string, when: string): string {
  return `Send bug report: ${title}, ${outcome}, ${when}`;
}

/**
 * The control itself. On a row it is a 44px sibling of the row (never inside
 * it) whose visible text is `Report` below `tablet:`; in detail it always
 * reads `Send bug report`. A native button so its accessible name can carry
 * the run it reports.
 */
export function ReportButton({ runId, name, placement, onClick }: {
  runId: string;
  name: string;
  placement: "row" | "detail";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={name}
      data-report-run={runId}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border-subtle bg-transparent px-2 text-xs text-foreground transition-colors hover:bg-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bk-focus-ring)]",
        placement === "detail" && "w-full px-3 tablet:w-auto"
      )}
    >
      <Flag aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-destructive" />
      {placement === "row" ? (
        <>
          <span className="tablet:hidden">Report</span>
          <span className="hidden tablet:inline">Send bug report</span>
        </>
      ) : (
        <span>Send bug report</span>
      )}
    </button>
  );
}

export function ActivityReportSheet({ request, server, onClose }: {
  request: ActivityReportRequest;
  /** `/api/status`'s software identity, when this page loaded and was allowed it. */
  server: SystemStatus["software"] | null;
  onClose: () => void;
}) {
  const root = useBrainUiRoot();
  const [record, setRecord] = useState<ReportRecord>(
    () => request.record ?? (request.run.detailPruned ? { state: "pruned" } : { state: "loading" })
  );
  const [lateNotice, setLateNotice] = useState<string | undefined>();
  const [late, setLate] = useState(false);
  // The record's own rollup can carry a reason the row's summary lacked (a
  // run promoted from the live stream has none); it is offered, never added.
  const [fetched, setFetched] = useState<ActivityRunRollup | null>(null);
  const { runId, run } = request;
  const held = Boolean(request.record) || Boolean(run.detailPruned);

  // From a row the run's own record is read once, without payloads. A pruned
  // run has nothing more to read; one already held is not fetched again.
  useEffect(() => {
    if (held) return;
    let active = true;
    root.api.activityRun(runId)
      .then((detail) => {
        if (!active) return;
        setFetched(detail.rollup ?? null);
        setRecord(detail.detailPruned ? { state: "pruned" } : { state: "retained", spans: detail.spans ?? [] });
      })
      .catch((err) => {
        if (!active) return;
        setRecord(err instanceof ApiRequestError && err.status === 404
          ? { state: "not-found" }
          : { state: "unloaded", offline: isOffline(root.stores.connection.getState().wsStatus) });
      });
    return () => { active = false; };
    // Read once per opened sheet; the request does not change while it is open.
  }, [root, runId, held]);

  // The record's rollup fills facts the opener's summary lacked (a run
  // promoted from the live stream knows no billing or reason yet). Only the
  // allowlisted fields are read, and a value the summary had is kept.
  const facts = useMemo<ReportRun>(() => fetched ? {
    ...run,
    durationMs: run.durationMs ?? fetched.durationMs,
    billingMode: run.billingMode ?? fetched.billingMode,
    failureReason: run.failureReason ?? fetched.failureReason,
  } : run, [run, fetched]);
  const body = useMemo(() => activityReportBody(facts, record, { client: CLIENT_RELEASE, server }), [facts, record, server]);
  const spans = record.state === "retained" ? record.spans : null;
  const offlineRecord = record.state === "unloaded" && record.offline;
  const stepLine = useMemo(() => {
    const lines = body.split("\n").filter((l) => l.startsWith("record: ") || l.startsWith("failed steps: "));
    return lines.length ? lines.join("\n") : null;
  }, [body]);

  return (
    <DiagnosticReview
      mode="report"
      initialBody={body}
      title={{ initial: activityReportTitle(run) }}
      defaultIssueTitle={activityReportTitle(run)}
      copy={ACTIVITY_REVIEW_COPY}
      meter
      note={offlineRecord ? OFFLINE_NOTE : undefined}
      notice={lateNotice}
      onLateBody={() => {
        setLate(true);
        setLateNotice(record.state === "retained" ? "Step details loaded. Add the step summary below to include it." : "The run record could not be read. Your edits are kept.");
      }}
      inclusions={[
        { id: "reason", label: "+ Add failure reason for review", build: () => failureReasonInclusion(facts, spans),
          notice: "Failure reason added below. Review it before sending." },
        { id: "job", label: "+ Add job name for review", build: () => jobNameInclusion(run),
          notice: "Job name added below. Review it before sending." },
        { id: "steps", label: "+ Add step summary", build: () => (late && record.state === "retained" ? stepLine : null),
          notice: "Step summary added below. Review it before sending." },
      ]}
      onClose={onClose}
      returnFocus={() => {
        const again = document.querySelector<HTMLElement>(`[data-report-run="${CSS.escape(runId)}"]`);
        if (again) { again.focus(); return; }
        // The lens or pane may have changed under the sheet; Actions' own
        // heading is always mounted.
        (document.querySelector<HTMLElement>(request.from === "row" ? "[data-history-heading]" : "[data-run-detail-heading]")
          ?? document.querySelector<HTMLElement>("[data-activity-heading]"))?.focus();
      }}
    />
  );
}
