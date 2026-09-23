// The `blocked` label, checked against the blockers it names.
//
// A label cannot notice that its reason went away. On 2026-09-22 three issues
// still carried `blocked` after their blockers had closed, and each stayed out
// of the Ready view until a triage pass happened to look. The script reads the
// `Blocked by #N` lines instead, and these assertions pin what it may conclude
// from them — including when it must refuse to conclude anything.

import { describe, expect, test } from "bun:test";
import {
  blockedVerdict,
  blockersIn,
  reconcileBlocked,
  type BlockerState,
} from "../scripts/sync-project.ts";

const REPO = "schlessera/brain-kit";

const issue = (number: number, labels: string[], body: string, repo = REPO) => ({
  number,
  repo,
  body,
  labels: labels.map((name) => ({ name })),
});

const states =
  (known: Record<string, BlockerState>) =>
  (ref: string): BlockerState | undefined =>
    known[ref];

describe("blockersIn", () => {
  test("reads `Blocked by #N` on its own line, in the issue's own repository", () => {
    expect(blockersIn("Context.\n\nBlocked by #110\n\nMore.", REPO)).toEqual([`${REPO}#110`]);
  });

  test("reads a cross-repository blocker as written", () => {
    expect(blockersIn("Blocked by schlessera/brain-kit#194", "schlessera/brain-ui")).toEqual([
      "schlessera/brain-kit#194",
    ]);
  });

  test("reads every blocker on the line, and every line", () => {
    expect(blockersIn("Blocked by #1 and #2\nblocked by: #3", REPO)).toEqual([
      `${REPO}#1`,
      `${REPO}#2`,
      `${REPO}#3`,
    ]);
  });

  test("ignores a mention that is not the convention", () => {
    // Prose about being blocked names no machine-readable target, and an
    // example inside a fence is documentation, not a dependency.
    const body = [
      "This is **blocked** until #54 lands.",
      "The obvious fix is blocked by #86 in practice.",
      "See #86 — the obvious fix re-breaks it.",
      "```",
      "Blocked by #42",
      "```",
    ].join("\n");
    expect(blockersIn(body, REPO)).toEqual([]);
  });
});

describe("blockedVerdict", () => {
  test("an issue whose every blocker is closed is reported as cleared", () => {
    const verdict = blockedVerdict(
      issue(111, ["agent-ready", "blocked"], "Blocked by #110"),
      states({ [`${REPO}#110`]: "closed" }),
    );
    expect(verdict).toEqual({ kind: "cleared", closed: [`${REPO}#110`] });
  });

  test("one open blocker among closed ones keeps it blocked", () => {
    const verdict = blockedVerdict(
      issue(145, ["blocked"], "Blocked by #124\nBlocked by #148"),
      states({ [`${REPO}#124`]: "closed", [`${REPO}#148`]: "open" }),
    );
    expect(verdict).toEqual({ kind: "still-blocked", open: [`${REPO}#148`] });
  });

  test("`blocked` with no `Blocked by` line is unverifiable, not unblocked", () => {
    const verdict = blockedVerdict(
      issue(23, ["agent-ready", "blocked"], "Part of #19, after #22."),
      states({}),
    );
    expect(verdict.kind).toBe("unverifiable");
  });

  test("a blocker whose state cannot be read is unverifiable, not closed", () => {
    const verdict = blockedVerdict(issue(97, ["blocked"], "Blocked by #174"), states({}));
    expect(verdict.kind).toBe("unverifiable");
  });

  test("an issue without the label is not the script's business", () => {
    // A `Blocked by` line with no label is somebody's note; adding the label
    // is a triage judgement the script does not make.
    const verdict = blockedVerdict(
      issue(5, ["agent-ready"], "Blocked by #4"),
      states({ [`${REPO}#4`]: "open" }),
    );
    expect(verdict).toEqual({ kind: "not-blocked" });
  });
});

/** A tracker the reconcile pass can talk to without the network. */
function fakeTracker(fixtures: ReturnType<typeof issue>[], known: Record<string, BlockerState>) {
  const labels = new Map(fixtures.map((f) => [f.number, new Set(f.labels.map((l) => l.name))]));
  const comments = new Map<number, string[]>();
  return {
    comments,
    labels,
    /** Fresh copies, the way a new `gh issue list` would return them. */
    list: () =>
      fixtures.map((f) => ({
        ...f,
        labels: [...labels.get(f.number)!].map((name) => ({ name })),
      })),
    io: {
      state: async (ref: string) => known[ref],
      removeLabel: async (target: { number: number }) => {
        labels.get(target.number)!.delete("blocked");
      },
      comment: async (target: { number: number }, text: string) => {
        comments.set(target.number, [...(comments.get(target.number) ?? []), text]);
      },
    },
  };
}

describe("reconcileBlocked", () => {
  const fixtures = () => [
    issue(111, ["agent-ready", "blocked"], "Blocked by #110"),
    issue(145, ["agent-ready", "blocked"], "Blocked by #148"),
    issue(23, ["agent-ready", "blocked"], "No blocker named here."),
  ];
  const known: Record<string, BlockerState> = {
    [`${REPO}#110`]: "closed",
    [`${REPO}#148`]: "open",
  };

  test("a dry run lists the cleared and the unverifiable, and changes nothing", async () => {
    const tracker = fakeTracker(fixtures(), known);
    const report = await reconcileBlocked(tracker.list(), tracker.io, false);
    expect(report.cleared.map((r) => r.issue.number)).toEqual([111]);
    expect(report.unverifiable.map((r) => r.issue.number)).toEqual([23]);
    expect(tracker.labels.get(111)!.has("blocked")).toBe(true);
    expect(tracker.comments.size).toBe(0);
  });

  test("--apply removes the label and comments once, naming the closed blocker", async () => {
    const tracker = fakeTracker(fixtures(), known);
    const issues = tracker.list();
    await reconcileBlocked(issues, tracker.io, true);

    expect(tracker.labels.get(111)!.has("blocked")).toBe(false);
    expect(tracker.comments.get(111)).toHaveLength(1);
    expect(tracker.comments.get(111)![0]).toContain("#110");
    expect(tracker.comments.get(111)![0]).not.toContain("\n");
    // The in-memory issue is updated too, so the same run derives it as Ready.
    expect(issues[0].labels.map((l) => l.name)).not.toContain("blocked");

    // Neither the still-blocked nor the unverifiable one is touched.
    expect(tracker.labels.get(145)!.has("blocked")).toBe(true);
    expect(tracker.labels.get(23)!.has("blocked")).toBe(true);
    expect(tracker.comments.has(145)).toBe(false);
    expect(tracker.comments.has(23)).toBe(false);
  });

  test("a second --apply run does nothing", async () => {
    const tracker = fakeTracker(fixtures(), known);
    await reconcileBlocked(tracker.list(), tracker.io, true);
    const second = await reconcileBlocked(tracker.list(), tracker.io, true);
    expect(second.cleared).toEqual([]);
    expect(tracker.comments.get(111)).toHaveLength(1);
  });
});
