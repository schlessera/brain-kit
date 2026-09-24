// A dry run is only useful if it says what `--apply` will do. `sweep` runs
// the same pass in both modes; these run it twice over the same fake board
// and tracker and hold the dry run's plan to the writes `--apply` makes.

import { describe, expect, test } from "bun:test";
import {
  summaryLine,
  sweep,
  type BlockerState,
  type BoardIO,
  type BlockerIO,
  type Counts,
} from "../scripts/sync-project.ts";

const REPO = "schlessera/brain-kit";
const url = (n: number) => `https://github.com/${REPO}/issues/${n}`;

const option = (name: string) => ({ id: `opt-${name}`, name });
const fields = new Map(
  [
    { id: "f-status", name: "Status", options: ["Backlog", "Ready", "In progress", "In review", "Done"].map(option) },
    { id: "f-priority", name: "Priority", options: ["P0", "P1", "P2", "P3"].map(option) },
    { id: "f-track", name: "Track", options: [option("Design system")] },
  ].map((field) => [field.name, field]),
);

/** Every kind of change a sweep makes, and the cases it must leave alone. */
const fixture = () => ({
  issues: [
    // On the board in Backlog, now agent-ready: a Status change.
    { number: 1, title: "ready now", url: url(1), repo: REPO, body: "", labels: [{ name: "agent-ready" }] },
    // Not on the board: an add, then its Priority, Track and Status.
    { number: 2, title: "new", url: url(2), repo: REPO, body: "", labels: [{ name: "agent-ready" }, { name: "priority: p1" }] },
    // Blocked by a closed issue: an unblock, and the Status that follows from it.
    { number: 3, title: "unblocks", url: url(3), repo: REPO, body: "Blocked by #9", labels: [{ name: "agent-ready" }, { name: "blocked" }] },
    // A person moved it to In progress: nothing.
    { number: 4, title: "in progress", url: url(4), repo: REPO, body: "", labels: [{ name: "agent-ready" }] },
    // Unblocked, but a `needs:` label still holds it: the unblock, and no Status
    // change. A dry run that projected more than the `blocked` removal would
    // plan Ready here while --apply keeps Backlog.
    { number: 5, title: "still needs design", url: url(5), repo: REPO, body: "Blocked by #9", labels: [{ name: "agent-ready" }, { name: "blocked" }, { name: "needs: design" }] },
    // Labelled `blocked` with no declaration: reported, never cleared.
    { number: 6, title: "unverifiable", url: url(6), repo: REPO, body: "", labels: [{ name: "blocked" }] },
    // An open PR says it closes this one: In review, from the review set.
    { number: 7, title: "in review", url: url(7), repo: REPO, body: "", labels: [{ name: "agent-ready" }] },
  ],
  items: new Map<string, { itemId?: string; current?: Record<string, string | undefined> }>([
    [url(1), { itemId: "item-1", current: { Status: "Backlog" } }],
    [url(3), { itemId: "item-3", current: { Status: "Backlog" } }],
    [url(4), { itemId: "item-4", current: { Status: "In progress" } }],
    [url(5), { itemId: "item-5", current: { Status: "Backlog" } }],
    [url(6), { itemId: "item-6", current: { Status: "Backlog" } }],
    [url(7), { itemId: "item-7", current: { Status: "Ready" } }],
  ]),
});

/** #2 is on a track, so its dry run and apply both carry a Track change. */
const membership = new Map([["Design system", new Set([`${REPO}#2`])]]);

function run(apply: boolean, fail: { editOn?: string; add?: boolean } = {}) {
  const { issues, items } = fixture();
  const writes: string[] = [];
  const log: string[] = [];
  const states: Record<string, BlockerState> = { [`${REPO}#9`]: "closed" };
  const tracker: BlockerIO = {
    state: async (ref) => states[ref],
    removeLabel: async (i) => void writes.push(`unlabel #${i.number}`),
    comment: async (i) => void writes.push(`comment #${i.number}`),
    hasComment: async () => false,
  };
  const board: BoardIO = {
    add: async (i) => {
      if (fail.add) throw new Error("gh project item-add failed");
      writes.push(`add ${i.url}`);
      return `item-new-${i.url.split("/").pop()}`;
    },
    edit: async (itemId, fieldId, optionId) => {
      if (itemId === fail.editOn) throw new Error("gh project item-edit failed");
      writes.push(`edit ${itemId} ${fieldId}=${optionId}`);
    },
  };
  const counts: Counts = { added: 0, edited: 0 };
  const done = sweep(issues, {
    apply,
    tracker,
    board,
    items,
    fields,
    membership,
    underReview: new Set([`${REPO}#7`]),
    counts,
    log: (line) => log.push(line),
  });
  return { done, writes, log, counts };
}

/** A dry-run line as the line `--apply` prints for the same change. */
const asApplied = (line: string) =>
  line
    .replace(/^would add (\S+) {2}.*$/, "added $1")
    .replace(/^would set /, "set ")
    .replace(/^would unblock /, "unblocked ");

describe("sweep", () => {
  test("the dry run's plan is exactly what --apply then does", async () => {
    const dry = run(false);
    await dry.done;
    const applied = run(true);
    await applied.done;

    expect(dry.writes).toEqual([]);
    // A dry run never claims to have done anything: every line is a "would"
    // or a report, so the mapping below cannot hide an applied-sounding line.
    expect(dry.log.filter((line) => !/^(would |cannot verify )/.test(line))).toEqual([]);
    expect(dry.log.map(asApplied)).toEqual(applied.log);
    // The fixture exercises every kind of change, so an empty plan cannot pass.
    expect(applied.log).toEqual([
      `unblocked ${REPO}#3: every blocker is closed (${REPO}#9)`,
      `unblocked ${REPO}#5: every blocker is closed (${REPO}#9)`,
      `cannot verify blocked ${REPO}#6: labelled \`blocked\` with no \`Blocked by #N\` line`,
      `set ${REPO}#1 Status: Backlog -> Ready`,
      `added ${REPO}#2`,
      `set ${REPO}#2 Priority: (unset) -> P1`,
      `set ${REPO}#2 Track: (unset) -> Design system`,
      `set ${REPO}#2 Status: (unset) -> Ready`,
      `set ${REPO}#3 Status: Backlog -> Ready`,
      `set ${REPO}#7 Status: Ready -> In review`,
    ]);
    // And every line `--apply` printed is a write it made.
    expect(applied.writes).toEqual([
      "comment #3",
      "unlabel #3",
      "comment #5",
      "unlabel #5",
      "edit item-1 f-status=opt-Ready",
      `add ${url(2)}`,
      "edit item-new-2 f-priority=opt-P1",
      "edit item-new-2 f-track=opt-Design system",
      "edit item-new-2 f-status=opt-Ready",
      "edit item-3 f-status=opt-Ready",
      "edit item-7 f-status=opt-In review",
    ]);
  });

  test("a new item's fields are in the dry run", async () => {
    const dry = run(false);
    await dry.done;
    expect(dry.log).toContain(`would set ${REPO}#2 Status: (unset) -> Ready`);
    expect(dry.log).toContain(`would set ${REPO}#2 Priority: (unset) -> P1`);
    expect(dry.log).toContain(`would set ${REPO}#2 Track: (unset) -> Design system`);
  });

  test("the Status an unblock produces is in the dry run", async () => {
    const dry = run(false);
    await dry.done;
    expect(dry.log).toContain(`would set ${REPO}#3 Status: Backlog -> Ready`);
  });

  test("both modes count the same changes, and the summary says so", async () => {
    const dry = run(false);
    await dry.done;
    const applied = run(true);
    await applied.done;
    expect(dry.counts).toEqual({ added: 1, edited: 6 });
    expect(applied.counts).toEqual({ added: 1, edited: 6 });
    expect(summaryLine(false, dry.counts)).toBe("Dry run: 1 item(s) added, 6 field value(s) set.");
    expect(summaryLine(true, applied.counts)).toBe("Applied: 1 item(s) added, 6 field value(s) set.");
  });

  test("a failed write stops the run, is not counted and is not logged as set", async () => {
    const applied = run(true, { editOn: "item-new-2" });
    await expect(applied.done).rejects.toThrow("item-edit failed");
    // #1 was set before the failure; #2 was added, then its first edit failed.
    expect(applied.counts).toEqual({ added: 1, edited: 1 });
    expect(applied.log.filter((line) => line.startsWith(`set ${REPO}#2`))).toEqual([]);
  });

  test("a failed add is not counted, not logged, and gets no field writes", async () => {
    const applied = run(true, { add: true });
    await expect(applied.done).rejects.toThrow("item-add failed");
    expect(applied.counts.added).toBe(0);
    expect(applied.log.some((line) => line.startsWith(`added ${REPO}#2`))).toBe(false);
    expect(applied.writes.some((w) => w.startsWith("edit item-new-2"))).toBe(false);
    // The run got as far as #2: #1's Status was already written.
    expect(applied.writes).toContain("edit item-1 f-status=opt-Ready");
  });
});
