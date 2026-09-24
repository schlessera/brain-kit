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
  isOwnNotice,
  parseBlockers,
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

  test("a fence closes only on its own delimiter", () => {
    // A ``` line inside a ~~~~ example is part of the example. Toggling on it
    // would read the example's blocker and skip the real one after the fence.
    const body = [
      "~~~~markdown",
      "```",
      "Blocked by #1",
      "~~~~",
      "Blocked by #2",
    ].join("\n");
    expect(blockersIn(body, REPO)).toEqual([`${REPO}#2`]);
  });

  test("reads a body with CRLF line endings", () => {
    expect(blockersIn("Context.\r\nBlocked by #7\r\n", REPO)).toEqual([`${REPO}#7`]);
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

describe("a declaration read in part is not read at all", () => {
  test("a declaration in any other markdown context is unreadable, not skipped", () => {
    // An indented example, a quote, a nested item, an HTML comment: none is a
    // plain declaration, and skipping one could hide an open blocker.
    // Each case on its own, with no other line to make it unreadable.
    for (const body of [
      "    Blocked by #1",
      "  > Blocked by #1",
      "- > Blocked by #1",
      "- Dependencies\n  - Blocked by #1",
      "- Dependencies\n  Blocked by #1",
      "-\tBlocked by #1",
      "- [ ] Blocked by #1",
      "<!--\nBlocked by #1\n-->",
      "<!-- Blocked by #1 -->",
    ]) {
      const parsed = parseBlockers(body, REPO);
      expect({ body, refs: parsed.refs, unreadable: parsed.unreadable.length }).toEqual({
        body,
        refs: [],
        unreadable: 1,
      });
    }
  });

  test("no formatting of a second declaration lets the first clear the label alone", () => {
    // Each body declares #1 plainly and #2 in some other way. Whatever the
    // parser makes of the second line, it must not be silently dropped.
    const closedOne = states({ [`${REPO}#1`]: "closed" });
    for (const second of [
      "__Blocked by__ #2",
      "_Blocked by_ #2",
      "## Blocked by #2",
      "Blocked by #1 and https://GITHUB.COM/o/r/issues/2",
      "Blocked by #1 and the `<!--` parsing fix in #2",
      "```html\n<!-- example opener\n```\n\n<!-- unrelated note -->\n\nBlocked by #2",
    ]) {
      const verdict = blockedVerdict(issue(9, ["blocked"], `Blocked by #1\n\n${second}`), closedOne);
      expect({ second, kind: verdict.kind }).toEqual({ second, kind: "unverifiable" });
    }
  });

  test("a fence inside an HTML comment does not hide the declarations after it", () => {
    const body = ["Blocked by #1", "<!--", "```", "-->", "Blocked by #2"].join("\n");
    expect(blockersIn(body, REPO)).toEqual([`${REPO}#1`, `${REPO}#2`]);
  });

  test("a reference with a suffix is not read as its prefix", () => {
    expect(parseBlockers("Blocked by #1abc", REPO).refs).toEqual([]);
    expect(parseBlockers("Blocked by https://github.com/o/r/issues/5abc", REPO).refs).toEqual([]);
    expect(blockersIn("Blocked by https://github.com/o/r/issues/5#issuecomment-1.", REPO)).toEqual([
      "o/r#5",
    ]);
  });

  test("a declaration that names no reference first is unreadable", () => {
    expect(parseBlockers("Blocked by a design decision; #1 is only an example.", REPO)).toEqual({
      refs: [],
      unreadable: ["Blocked by a design decision; #1 is only an example."],
    });
  });

  test("a reference left over after the list makes the line unreadable", () => {
    // Reading #1 and skipping the URL would clear the label on #1 alone.
    const line = "Blocked by #1 and the fix in https://github.com/o/r/issues/5";
    expect(parseBlockers(line, REPO)).toEqual({ refs: [], unreadable: [line] });
  });

  test("an issue URL is a reference", () => {
    expect(blockersIn("Blocked by https://github.com/o/r/issues/5, #2", REPO)).toEqual([
      "o/r#5",
      `${REPO}#2`,
    ]);
  });

  test("commentary after the list is allowed", () => {
    expect(parseBlockers("Blocked by #110 (the store rewrite)", REPO)).toEqual({
      refs: [`${REPO}#110`],
      unreadable: [],
    });
  });

  test("an unreadable declaration keeps the label, even when the rest is closed", () => {
    const verdict = blockedVerdict(
      issue(9, ["blocked"], "Blocked by #1\nBlocked by the design review"),
      states({ [`${REPO}#1`]: "closed" }),
    );
    expect(verdict.kind).toBe("unverifiable");
  });
});

describe("isOwnNotice", () => {
  const marker = "<!-- sync-project: unblocked by o/r#1 -->";
  test("is the whole one-line notice, not a quote of it", () => {
    expect(isOwnNotice(`Unblocked: #1 is closed. ${marker}`, marker)).toBe(true);
    expect(isOwnNotice(`Unblocked: #1 is closed. ${marker}\nand more`, marker)).toBe(false);
    expect(isOwnNotice(`Example:\n\`\`\`\nUnblocked: #1 is closed. ${marker}\n\`\`\``, marker)).toBe(
      false,
    );
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
  /** Calls to make fail once, to model a run that dies half way. */
  const failNext = { comment: false, removeLabel: false };
  return {
    failNext,
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
        if (failNext.removeLabel) {
          failNext.removeLabel = false;
          throw new Error("gh issue edit failed");
        }
        labels.get(target.number)!.delete("blocked");
      },
      comment: async (target: { number: number }, text: string) => {
        if (failNext.comment) {
          failNext.comment = false;
          throw new Error("gh issue comment failed");
        }
        comments.set(target.number, [...(comments.get(target.number) ?? []), text]);
      },
      hasComment: async (target: { number: number }, marker: string) =>
        (comments.get(target.number) ?? []).some((text) => isOwnNotice(text, marker)),
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
    const report = await reconcileBlocked(tracker.list(), tracker.io, false, [REPO]);
    expect(report.cleared.map((r) => r.issue.number)).toEqual([111]);
    expect(report.unverifiable.map((r) => r.issue.number)).toEqual([23]);
    expect(tracker.labels.get(111)!.has("blocked")).toBe(true);
    expect(tracker.comments.size).toBe(0);
  });

  test("--apply removes the label and comments once, naming the closed blocker", async () => {
    const tracker = fakeTracker(fixtures(), known);
    const issues = tracker.list();
    await reconcileBlocked(issues, tracker.io, true, [REPO]);

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

  test("a run that dies before commenting retries on the next run", async () => {
    const tracker = fakeTracker(fixtures(), known);
    tracker.failNext.comment = true;
    await expect(reconcileBlocked(tracker.list(), tracker.io, true, [REPO])).rejects.toThrow();
    // Nothing is half done: the label is still on, so the next run sees it.
    expect(tracker.labels.get(111)!.has("blocked")).toBe(true);
    await reconcileBlocked(tracker.list(), tracker.io, true, [REPO]);
    expect(tracker.labels.get(111)!.has("blocked")).toBe(false);
    expect(tracker.comments.get(111)).toHaveLength(1);
  });

  test("a run that dies after commenting does not comment again", async () => {
    const tracker = fakeTracker(fixtures(), known);
    tracker.failNext.removeLabel = true;
    await expect(reconcileBlocked(tracker.list(), tracker.io, true, [REPO])).rejects.toThrow();
    // The comment landed before the removal failed.
    expect(tracker.comments.get(111)).toHaveLength(1);
    expect(tracker.labels.get(111)!.has("blocked")).toBe(true);
    await reconcileBlocked(tracker.list(), tracker.io, true, [REPO]);
    expect(tracker.labels.get(111)!.has("blocked")).toBe(false);
    expect(tracker.comments.get(111)).toHaveLength(1);
  });

  test("reordering the same blockers does not post a second notice", async () => {
    const two = () => [issue(7, ["blocked"], "Blocked by #1 and #2")];
    const closed: Record<string, BlockerState> = { [`${REPO}#1`]: "closed", [`${REPO}#2`]: "closed" };
    const tracker = fakeTracker(two(), closed);
    tracker.failNext.removeLabel = true;
    await expect(reconcileBlocked(tracker.list(), tracker.io, true, [REPO])).rejects.toThrow();
    const reordered = tracker.list().map((i) => ({ ...i, body: "Blocked by #2 and #1" }));
    await reconcileBlocked(reordered, tracker.io, true, [REPO]);
    expect(tracker.comments.get(7)).toHaveLength(1);
  });

  test("a blocker outside the board's repositories is never looked up or reported", async () => {
    // A public issue edited to name a private one must not make the run read
    // that issue's state with its token and post the answer publicly.
    const outside = () => [issue(5, ["blocked"], "Blocked by schlessera/brain-ui#29")];
    const tracker = fakeTracker(outside(), { "schlessera/brain-ui#29": "closed" });
    const looked: string[] = [];
    const io = { ...tracker.io, state: async (ref: string) => (looked.push(ref), tracker.io.state(ref)) };
    const report = await reconcileBlocked(tracker.list(), io, true, [REPO]);
    expect(looked).toEqual([]);
    expect(report.cleared).toEqual([]);
    expect(report.unverifiable.map((r) => r.reason)).toEqual([
      "names a blocker outside the board's repositories: schlessera/brain-ui#29",
    ]);
    expect(tracker.labels.get(5)!.has("blocked")).toBe(true);
    expect(tracker.comments.has(5)).toBe(false);
  });

  test("a second --apply run does nothing", async () => {
    const tracker = fakeTracker(fixtures(), known);
    await reconcileBlocked(tracker.list(), tracker.io, true, [REPO]);
    const second = await reconcileBlocked(tracker.list(), tracker.io, true, [REPO]);
    expect(second.cleared).toEqual([]);
    expect(tracker.comments.get(111)).toHaveLength(1);
  });
});
