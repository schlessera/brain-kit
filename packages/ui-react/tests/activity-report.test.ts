// The Activity bug report's generated text (#598): an allowlist of facts the
// app already holds. Odysseus fixtures; the synthetic secrets, paths and
// private prose are planted in every field the allowlist must leave out.
import { describe, expect, test } from "bun:test";
import { PROTOCOL_REV, type ActivitySpan } from "@schlessera/brain-ui-sdk/protocol";

import {
  activityReportBody,
  activityReportTitle,
  failureReasonInclusion,
  jobNameInclusion,
  type ReportRun,
} from "../src/lib/activity-report.js";
import { INCLUDED_TEXT_CAP } from "../src/lib/turn-failure.js";

const SECRET = "sk-odyssey-0000000000000000";
const PATH = "/home/penelope/loom/ledger.md";
const HOST = "ithaca-harbour.example";
const PROSE = "Telemachus asked about the suitors' wine bill";

const run: ReportRun = {
  origin: "cron",
  outcome: "timeout",
  durationMs: 242_000,
  billingMode: "subscription",
  failureReason: `Bash timed out reading ${PATH} on ${HOST} with token=${SECRET}`,
  jobName: "Penelope loom ledger",
  detailPruned: false,
};

function span(over: Partial<ActivitySpan>): ActivitySpan {
  return {
    spanId: "s-root", runId: "run-odysseus-7f3c", name: "cron:Penelope loom ledger", kind: "cron", origin: "cron",
    sessionId: "session-telemachus", jobName: "Penelope loom ledger", startedAt: Date.parse("2026-07-12T06:00:00Z"),
    ...over,
  } as ActivitySpan;
}

const spans: ActivitySpan[] = [
  span({ outcome: "timeout", outcomeReason: `root reason ${SECRET}` }),
  span({ spanId: "s-1", parentSpanId: "s-root", kind: "tool", toolName: "Read", name: `Read ${PATH}`, outcome: "success" }),
  span({ spanId: "s-2", parentSpanId: "s-root", kind: "tool", toolName: "Bash", name: `Bash cat ${PATH}`, outcome: "timeout",
    outcomeReason: PROSE, attrs: { command: `curl https://${HOST}/?key=${SECRET}` } }),
  span({ spanId: "s-3", parentSpanId: "s-root", kind: "tool", toolName: "mcp__penelope_private__weave", name: "weave", outcome: "error" }),
];

const ctx = { client: "0.41.2", server: { release: "0.41.2", sourceCommit: "a1b2c3d" } };

describe("the default body is an allowlist", () => {
  test("a retained failed cron run lists only the allowed facts", () => {
    const body = activityReportBody(run, { state: "retained", spans }, ctx);
    const facts = body.slice(body.indexOf("---\n") + 4).split("\n");
    expect(facts).toEqual([
      "brain-kit activity failure",
      `protocol: ${PROTOCOL_REV}`,
      "client: 0.41.2",
      "server: 0.41.2",
      "server commit: a1b2c3d",
      "origin: cron",
      "outcome: timeout",
      "duration: 4m 2s",
      "record: retained · 4 steps",
      "failed steps: Bash, other tool",
      "billing: subscription",
    ]);
    expect(body.startsWith("## What were you doing?\n\n## Steps to reproduce\n1.\n\n## Expected\n\n## Actual\n")).toBe(true);
  });

  test("secrets, paths, hosts, private prose, job names, IDs and payloads are absent by default", () => {
    const body = activityReportBody(run, { state: "retained", spans }, ctx) + activityReportTitle(run);
    expect(body.length).toBeGreaterThan(100);
    for (const leak of [SECRET, PATH, HOST, PROSE, "Penelope", "loom", "run-odysseus-7f3c", "session-telemachus",
      "s-root", "weave", "curl", "root reason"]) {
      expect(body).not.toContain(leak);
    }
  });

  test("untrusted outcome and origin values never print as given", () => {
    const hostile = { ...run, origin: "<img src=x onerror=alert(1)>" as ReportRun["origin"], outcome: "success" as const };
    const body = activityReportBody(hostile, { state: "pruned" }, ctx);
    expect(body).toContain("origin: other");
    expect(body).not.toContain("<img");
    expect(body).not.toContain("outcome:");
  });
});

describe("limited records are honest", () => {
  test("pruned: rollup only, with no failed-steps line", () => {
    const body = activityReportBody({ ...run, detailPruned: true }, { state: "pruned" }, ctx);
    expect(body).toContain("record: rollup only (detail pruned)");
    expect(body).not.toContain("failed steps");
    expect(body).not.toContain("retained");
  });

  test("a row's pruned summary says so before anything is read", () => {
    expect(activityReportBody({ ...run, detailPruned: true }, { state: "loading" }, ctx)).toContain("record: rollup only (detail pruned)");
  });

  test("not found: says so, and claims no steps", () => {
    const body = activityReportBody(run, { state: "not-found" }, ctx);
    expect(body).toContain("record: not found");
    expect(body).not.toContain("failed steps");
  });

  test("offline: the steps are not loaded, in words", () => {
    expect(activityReportBody(run, { state: "unloaded", offline: true }, ctx)).toContain("failed steps: not loaded (offline)");
    expect(activityReportBody(run, { state: "unloaded", offline: false }, ctx)).toContain("failed steps: not loaded\n");
  });

  test("while loading nothing is claimed about the record", () => {
    const body = activityReportBody(run, { state: "loading" }, ctx);
    expect(body).not.toContain("record:");
    expect(body).not.toContain("failed steps");
  });

  test("unknown duration and billing are omitted", () => {
    const body = activityReportBody({ ...run, durationMs: null, billingMode: undefined }, { state: "pruned" }, ctx);
    expect(body).not.toContain("duration:");
    expect(body).not.toContain("billing:");
  });
});

describe("version lines (acceptance check 11, amended)", () => {
  test("status loaded: server release and server commit from SystemStatus.software", () => {
    const body = activityReportBody(run, { state: "pruned" }, ctx);
    expect(body).toContain("\nserver: 0.41.2\n");
    expect(body).toContain("\nserver commit: a1b2c3d\n");
  });

  test("status not loaded: no server line at all", () => {
    const body = activityReportBody(run, { state: "pruned" }, { client: "0.41.2", server: null });
    expect(body).not.toMatch(/^server/m);
  });

  test("a source commit is never presented as a release", () => {
    const body = activityReportBody(run, { state: "pruned" }, { client: null, server: { release: "dev", sourceCommit: "a1b2c3d" } });
    expect(body).not.toMatch(/^server: /m);
    expect(body).toContain("server commit: a1b2c3d");
    expect(body).not.toContain("client:");
  });
});

describe("opt-in inclusions", () => {
  test("the failure reason is redacted and labelled", () => {
    const block = failureReasonInclusion(run, spans)!;
    expect(block.startsWith("Failure reason (review before sharing):\n")).toBe(true);
    expect(block).not.toContain(SECRET);
    expect(block).not.toContain(PATH);
    expect(block).not.toContain(HOST);
  });

  test("a long reason shows its cap", () => {
    const long = { ...run, failureReason: "Scylla ".repeat(600).trim() };
    const block = failureReasonInclusion(long, null)!;
    const shown = block.split("\n")[1]!;
    expect(long.failureReason.length).toBeGreaterThan(4000);
    expect(shown.length).toBe(INCLUDED_TEXT_CAP);
    expect(block).toContain(`[${long.failureReason.length - INCLUDED_TEXT_CAP} characters not included]`);
  });

  test("falls back to the failed root span's reason, else offers nothing", () => {
    expect(failureReasonInclusion({ ...run, failureReason: null }, spans)).toContain("root reason [redacted credential]");
    expect(failureReasonInclusion({ ...run, failureReason: null }, null)).toBeNull();
  });

  test("the job name only for a cron run that has one", () => {
    expect(jobNameInclusion(run)).toBe("job: Penelope loom ledger");
    expect(jobNameInclusion({ ...run, origin: "session" })).toBeNull();
    expect(jobNameInclusion({ ...run, jobName: null })).toBeNull();
  });
});
