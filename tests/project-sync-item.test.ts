// `syncItem` is the one place a board item's fields are written, for both the
// daily sweep and the per-event single-issue sync. These pin what it writes,
// what it refuses to touch, and that a dry run writes nothing.

import { describe, expect, test } from "bun:test";
import {
  boardRepo,
  closingRefs,
  parseTarget,
  syncItem,
  type BoardIO,
} from "../scripts/sync-project.ts";

const REPO = "schlessera/brain-kit";

const issue = (labels: string[], number = 46) => ({
  number,
  title: "an issue",
  url: `https://github.com/${REPO}/issues/${number}`,
  body: "",
  repo: REPO,
  labels: labels.map((name) => ({ name })),
});

const option = (name: string) => ({ id: `opt-${name}`, name });
const fields = new Map(
  [
    { id: "f-status", name: "Status", options: ["Backlog", "Ready", "In progress", "In review", "Done"].map(option) },
    { id: "f-priority", name: "Priority", options: ["P0", "P1", "P2", "P3"].map(option) },
    { id: "f-track", name: "Track", options: [option("Design system")] },
  ].map((field) => [field.name, field]),
);

function recorder(failEdit = false) {
  const writes: string[] = [];
  const log: string[] = [];
  const io: BoardIO = {
    add: async (i) => (writes.push(`add ${i.url}`), "item-new"),
    edit: async (itemId, fieldId, optionId) => {
      if (failEdit) throw new Error("gh project item-edit failed");
      writes.push(`${itemId} ${fieldId}=${optionId}`);
    },
  };
  return { writes, log, io };
}

const run = (
  labels: string[],
  opts: { apply?: boolean; current?: Record<string, string | undefined>; itemId?: string | null; failEdit?: boolean } = {},
) => {
  const r = recorder(opts.failEdit);
  const counts = { added: 0, edited: 0 };
  const done = syncItem(issue(labels), {
    apply: opts.apply ?? true,
    fields,
    membership: new Map(),
    underReview: new Set(),
    current: opts.current,
    itemId: opts.itemId === null ? undefined : (opts.itemId ?? "item-46"),
    io: r.io,
    counts,
    log: (line) => r.log.push(line),
  });
  return { ...r, counts, result: done.then(() => counts) };
};

describe("syncItem", () => {
  test("adding agent-ready moves a Backlog item to Ready, in one write", async () => {
    const { writes, log, result } = run(["agent-ready"], { current: { Status: "Backlog" } });
    expect(await result).toEqual({ added: 0, edited: 1 });
    expect(writes).toEqual(["item-46 f-status=opt-Ready"]);
    expect(log).toEqual([`set ${REPO}#46 Status: Backlog -> Ready`]);
  });

  test("removing agent-ready moves a Ready item back to Backlog", async () => {
    const { writes, result } = run([], { current: { Status: "Ready" } });
    await result;
    expect(writes).toEqual(["item-46 f-status=opt-Backlog"]);
  });

  test("a human handoff moves a Ready item to Backlog even with stale agent-ready", async () => {
    const { writes, result } = run(["agent-ready", "needs: human"], { current: { Status: "Ready" } });
    const counts = await result;
    expect(writes).toEqual(["item-46 f-status=opt-Backlog"]);
    expect(counts).toEqual({ added: 0, edited: 1 });
  });

  test("a Status a person set is never overwritten", async () => {
    for (const status of ["In progress", "Done"]) {
      const { writes, result } = run(["agent-ready"], { current: { Status: status } });
      await result;
      expect(writes).toEqual([]);
    }
  });

  test("a field already right is not written again", async () => {
    const { writes, result } = run(["agent-ready", "priority: p2"], {
      current: { Status: "Ready", Priority: "P2" },
    });
    expect(await result).toEqual({ added: 0, edited: 0 });
    expect(writes).toEqual([]);
  });

  test("a dry run writes nothing and reports what it would write", async () => {
    const { writes, log, result } = run(["agent-ready", "priority: p1"], { apply: false, current: { Status: "Backlog" } });
    expect(await result).toEqual({ added: 0, edited: 2 });
    expect(writes).toEqual([]);
    expect(log).toEqual([`would set ${REPO}#46 Priority: (unset) -> P1`, `would set ${REPO}#46 Status: Backlog -> Ready`]);
  });

  test("an issue not on the board is added, then its fields are set", async () => {
    const { writes, result } = run(["agent-ready"], { itemId: null });
    expect(await result).toEqual({ added: 1, edited: 1 });
    expect(writes).toEqual([`add https://github.com/${REPO}/issues/46`, "item-new f-status=opt-Ready"]);
  });

  test("a dry run reports the fields a new item would get, not only that it would be added", async () => {
    const { writes, log, result } = run(["agent-ready", "priority: p2"], { apply: false, itemId: null });
    expect(await result).toEqual({ added: 1, edited: 2 });
    expect(writes).toEqual([]);
    expect(log).toEqual([
      `would add ${REPO}#46  an issue`,
      `would set ${REPO}#46 Priority: (unset) -> P2`,
      `would set ${REPO}#46 Status: (unset) -> Ready`,
    ]);
  });

  test("a failed write is neither logged as set nor counted", async () => {
    const { log, counts, result } = run(["agent-ready"], { current: { Status: "Backlog" }, failEdit: true });
    await expect(result).rejects.toThrow("item-edit failed");
    expect(log.filter((line) => line.startsWith("set "))).toEqual([]);
    expect(counts).toEqual({ added: 0, edited: 0 });
  });
});

describe("event targets", () => {
  test("parseTarget reads owner/repo#N and nothing else", () => {
    expect(parseTarget(`${REPO}#46`)).toEqual({ repo: REPO, number: 46 });
    expect(parseTarget("#46")).toBeUndefined();
    expect(parseTarget(`${REPO}#46; rm -rf /`)).toBeUndefined();
  });

  test("boardRepo accepts the three public repositories in any case, and nothing else", () => {
    expect(boardRepo("Schlessera/Brain-Kit")).toBe(REPO);
    expect(boardRepo("schlessera/brain-template")).toBe("schlessera/brain-template");
    expect(boardRepo("schlessera/brain-ui")).toBeUndefined();
    expect(boardRepo("schlessera/brain")).toBeUndefined();
  });

  test("closingRefs reads the same-repository closing keywords", () => {
    expect(closingRefs("Closes #12\nfixes #13, resolves #14. See #15.", REPO)).toEqual([
      `${REPO}#12`,
      `${REPO}#13`,
      `${REPO}#14`,
    ]);
  });
});
