import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeWork, candidates, ineligible, labelGaps, labelProblems, main, type Gh, type Issue, type OpenPr } from "../issue-queue";

const REPO = "schlessera/brain-kit";
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function issue(number: number, labels: string[], overrides: Partial<Issue> = {}): Issue {
  return { number, title: `issue ${number}`, state: "open", stateReason: null, createdAt: "2026-07-12T00:00:00Z", updatedAt: "2026-07-12T00:00:00Z",
    labels, assignees: [], milestone: null, isPullRequest: false, comments: 0, body: "", ...overrides };
}
const READY = ["agent-ready", "type: fix", "area: core"];

/** A tracker in memory that answers the `gh` calls the script makes, and records the writes. */
function tracker(issues: Issue[], options: { prs?: OpenPr[]; parents?: Record<number, number>; rival?: boolean; comments?: Record<number, string[]> } = {}) {
  const byNumber = new Map(issues.map(entry => [entry.number, entry]));
  const writes: string[][] = [], posted: Array<{ issue: number; body: string }> = [];
  const raw = (entry: Issue) => JSON.stringify({ number: entry.number, title: entry.title, state: entry.state, state_reason: entry.stateReason,
    created_at: entry.createdAt, updated_at: entry.updatedAt, labels: entry.labels, assignees: entry.assignees, milestone: entry.milestone,
    pr: entry.isPullRequest, comments: entry.comments, body: entry.body });
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const notFound = { code: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: "gh: Not Found (HTTP 404)" };
  const gh: Gh = args => {
    const [command, sub] = args;
    if (command === "api" && sub === "user") return ok("odysseus\n");
    if (command === "api") {
      const url = args.find(arg => arg.startsWith("repos/"))!;
      const jq = args[args.indexOf("--jq") + 1] ?? "";
      const list = /^repos\/[^/]+\/[^/]+\/issues\?state=open/.exec(url);
      if (list) {
        const open = issues.filter(entry => entry.state === "open" && (!url.includes("labels=agent-ready") || entry.labels.includes("agent-ready")));
        return ok(open.map(raw).join("\n"));
      }
      const match = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)(\/parent|\/comments\?per_page=100)?$/.exec(url);
      if (!match) return notFound;
      const entry = byNumber.get(Number(match[2]));
      if (match[3] === "/parent") {
        const parent = byNumber.get(options.parents?.[Number(match[2])] ?? -1);
        return parent ? ok(JSON.stringify({ number: parent.number, title: parent.title, state: parent.state })) : notFound;
      }
      if (match[3]) return ok((options.comments?.[Number(match[2])] ?? []).map(body => JSON.stringify({ at: "2026-07-12T01:00:00Z", by: "odysseus", role: "OWNER", body })).join("\n"));
      if (!entry || match[1] !== REPO) return notFound;
      return ok(jq.startsWith("{state,state_reason,title}") ? JSON.stringify({ state: entry.state, state_reason: entry.stateReason, title: entry.title }) : raw(entry));
    }
    if (command === "pr" && sub === "list") return ok(JSON.stringify((options.prs ?? []).map(pr => ({ number: pr.number, headRefName: pr.head, isDraft: pr.draft, body: pr.body }))));
    if (command === "issue" && sub === "edit") {
      writes.push(args);
      const entry = byNumber.get(Number(args[2]))!;
      const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1]!.split(",") : []);
      if (args.includes("--add-assignee")) entry.assignees = [...entry.assignees, "odysseus", ...(options.rival ? ["antinous"] : [])];
      if (args.includes("--remove-assignee")) entry.assignees = entry.assignees.filter(login => login !== "odysseus");
      entry.labels = [...entry.labels.filter(label => !value("--remove-label").includes(label)), ...value("--add-label")];
      entry.updatedAt = "2026-07-12T02:00:00Z";
      return ok("");
    }
    if (command === "issue" && sub === "comment") {
      posted.push({ issue: Number(args[2]), body: readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8") });
      return ok("");
    }
    return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
  };
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const code = await main(argv, { gh, out: text => out.push(text), token: () => "claim-0dy55eu5" });
    return { code, json: JSON.parse(out.join("\n")) };
  };
  return { run, writes, posted, byNumber };
}

describe("which issue is next", () => {
  test("eligible issues come in priority order, then oldest, then lowest number", () => {
    const found = candidates([
      issue(30, [...READY, "priority: p2"], { createdAt: "2026-07-01T00:00:00Z" }),
      issue(10, [...READY, "priority: p1"], { createdAt: "2026-07-10T00:00:00Z" }),
      issue(20, [...READY, "priority: p1"], { createdAt: "2026-07-05T00:00:00Z" }),
      issue(21, [...READY, "priority: p1"], { createdAt: "2026-07-05T00:00:00Z" }),
      issue(40, [...READY, "priority: p0"], { createdAt: "2026-07-11T00:00:00Z" }),
    ], []);
    expect(found.candidates.map(entry => entry.number)).toEqual([40, 20, 21, 10, 30]);
  });

  test.each([
    ["a pull request", issue(1, [...READY, "priority: p1"], { isPullRequest: true }), "is a pull request"],
    ["an assigned issue", issue(1, [...READY, "priority: p1"], { assignees: ["antinous"] }), "is assigned to 1 account(s)"],
    ["an epic", issue(1, [...READY, "priority: p1", "epic"]), "is an epic"],
    ["an issue with an open need", issue(1, [...READY, "priority: p1", "needs: design"]), "carries needs: design"],
    ["an issue without agent-ready", issue(1, ["type: fix", "priority: p1"]), "lacks agent-ready"],
    ["a closed issue", issue(1, [...READY, "priority: p1"], { state: "closed" }), "is closed"],
  ])("%s is never a candidate", (_name, subject, reason) => {
    expect(ineligible(subject)).toBe(reason);
    expect(candidates([subject], []).candidates).toEqual([]);
  });

  test("a missing, doubled or unknown priority is reported as unsorted, never ranked by guess", () => {
    const found = candidates([issue(1, READY), issue(2, [...READY, "priority: p1", "priority: p2"]), issue(3, [...READY, "priority: urgent"]), issue(4, [...READY, "priority: p3"])], []);
    expect(found.candidates.map(entry => entry.number)).toEqual([4]);
    expect(found.unsorted.map(entry => [entry.number, entry.reason])).toEqual([[1, "no priority label"], [2, "priority labels: priority: p1, priority: p2"], [3, "priority labels: priority: urgent"]]);
  });

  test("a blocked issue stays in order as a lead that needs its stack review", () => {
    const found = candidates([issue(1, [...READY, "priority: p1", "blocked"]), issue(2, [...READY, "priority: p1"])], []);
    expect(found.candidates.map(entry => [entry.number, entry.requiresStackReview])).toEqual([[1, true], [2, false]]);
  });

  test("an open pull request on the issue's branch or naming it marks the issue as already in work", () => {
    const prs: OpenPr[] = [{ number: 900, head: "fix/12-oars", draft: false, body: "" }, { number: 901, head: "feat/sails", draft: true, body: "Refs #12 and closes #13." },
      { number: 902, head: "fix/112-bow", draft: false, body: "Refs #1200" }];
    expect([activeWork(12, prs), activeWork(13, prs), activeWork(1, prs), activeWork(120, prs)]).toEqual([[900, 901], [901], [], []]);
  });

  test("the candidates command prints the top of the queue and the unsorted ones", async () => {
    const { run } = tracker([issue(5, [...READY, "priority: p2"]), issue(6, [...READY, "priority: p1"]), issue(7, READY), issue(8, ["type: fix"])]);
    expect((await run("candidates", "--limit", "1")).json).toEqual({ repo: REPO, eligible: 2,
      candidates: [{ number: 6, title: "issue 6", priority: "priority: p1", createdAt: "2026-07-12T00:00:00Z", requiresStackReview: false, activeWork: [] }],
      unsorted: [{ number: 7, title: "issue 7", reason: "no priority label" }] });
  });

  test("the triage snapshot lists open issues without agent-ready and leaves pull requests out", async () => {
    const { run } = tracker([issue(5, READY), issue(6, ["type: fix"], { assignees: ["antinous"] }), issue(7, ["epic"]), issue(8, [], { isPullRequest: true }), issue(9, [], { state: "closed" })]);
    const snapshot = (await run("snapshot")).json;
    expect([snapshot.count, snapshot.issues.map((entry: { number: number; assigned?: boolean }) => [entry.number, entry.assigned ?? false])]).toEqual([2, [[6, true], [7, false]]]);
  });
});

describe("label rules", () => {
  test("contradictions are refused: agent-ready on an epic or beside a need, two types, two priorities", () => {
    expect(labelProblems({ labels: ["agent-ready", "epic"] })).toEqual(["an epic never carries agent-ready"]);
    expect(labelProblems({ labels: ["agent-ready", "needs: repro", "type: fix"] })).toEqual(["agent-ready with needs: repro"]);
    expect(labelProblems({ labels: ["type: fix", "type: test", "priority: p1", "priority: p2"] })).toEqual(["more than one type: type: fix, type: test", "more than one priority: priority: p1, priority: p2"]);
    expect(labelProblems({ labels: ["agent-ready", "blocked", "type: fix", "priority: p1"] })).toEqual([]);
  });

  test("a label outside the manifest is a problem only when a manifest is given", () => {
    expect(labelProblems({ labels: ["area: sirens"] }, new Set(["area: core"]))).toEqual(['unknown label "area: sirens"']);
    expect(labelProblems({ labels: ["area: sirens"] })).toEqual([]);
  });

  test("a missing type, area or priority is a gap for triage, and an epic needs no type", () => {
    expect(labelGaps(issue(1, []))).toEqual(["no type", "no area", "no priority"]);
    expect(labelGaps(issue(1, ["epic", "area: core", "priority: p2"]))).toEqual([]);
  });

  test("a label change is applied as a delta and read back", async () => {
    const { run, writes } = tracker([issue(5, ["type: fix", "area: core", "priority: p2", "needs: repro"])]);
    const result = await run("labels", "5", "--add", "agent-ready,priority: p2", "--remove", "needs: repro,needs: design");
    expect(result.json).toMatchObject({ applied: true, added: ["agent-ready"], removed: ["needs: repro"], labels: ["agent-ready", "area: core", "priority: p2", "type: fix"], gaps: [] });
    expect(writes).toEqual([["issue", "edit", "5", "--repo", REPO, "--add-label", "agent-ready", "--remove-label", "needs: repro"]]);
  });

  test("a change that would leave agent-ready beside a need is refused before anything is written", async () => {
    const { run, writes } = tracker([issue(5, ["type: fix", "priority: p2", "needs: repro"])]);
    const result = await run("labels", "5", "--add", "agent-ready");
    expect([result.code, result.json.problems, writes]).toEqual([1, ["agent-ready with needs: repro"], []]);
  });

  test("a label outside the manifest, a closed issue and a stale read are each refused", async () => {
    const { run, writes } = tracker([issue(5, ["type: fix"]), issue(6, ["type: fix"], { state: "closed" })]);
    await expect(run("labels", "5", "--add", "area: sirens")).rejects.toThrow("Not in the label manifest (scripts/labels.ts): area: sirens");
    await expect(run("labels", "6", "--add", "area: core")).rejects.toThrow("#6 is closed");
    expect((await run("labels", "5", "--add", "area: core", "--updated-at", "2026-07-11T00:00:00Z")).json).toMatchObject({ applied: false, updatedAt: "2026-07-12T00:00:00Z" });
    expect(writes).toEqual([]);
  });

  test("labels that are already as asked cause no write", async () => {
    const { run, writes } = tracker([issue(5, ["type: fix", "area: core"])]);
    expect((await run("labels", "5", "--add", "area: core", "--remove", "needs: repro")).json).toMatchObject({ applied: true, added: [], removed: [] });
    expect(writes).toEqual([]);
  });

  test("the check command separates contradictions from gaps", async () => {
    const { run } = tracker([issue(5, ["agent-ready", "epic", "area: core", "priority: p1"]), issue(6, ["type: fix", "area: core"]), issue(7, ["type: fix", "area: core", "priority: p2"])]);
    expect((await run("check")).json).toEqual({ repo: REPO, contradictions: [{ number: 5, title: "issue 5", problems: ["an epic never carries agent-ready"] }], gaps: [{ number: 6, gaps: ["no priority"] }] });
  });
});

describe("claiming and releasing", () => {
  test("a claim assigns, reads the assignment back and records its token and branch in a comment", async () => {
    const { run, writes, posted, byNumber } = tracker([issue(5, [...READY, "priority: p1"])]);
    expect((await run("claim", "5", "--branch", "fix/5-oars", "--note", "No collisions reported.")).json).toEqual({ claimed: true, issue: 5, token: "claim-0dy55eu5", branch: "fix/5-oars" });
    expect(byNumber.get(5)!.assignees).toEqual(["odysseus"]);
    expect(writes).toEqual([["issue", "edit", "5", "--repo", REPO, "--add-assignee", "@me"]]);
    expect(posted).toEqual([{ issue: 5, body: "Claimed for implementation. Claim token: `claim-0dy55eu5`. Branch: `fix/5-oars`.\n\nNo collisions reported." }]);
  });

  test("an issue that no longer qualifies is not touched", async () => {
    const { run, writes, posted } = tracker([issue(5, [...READY, "priority: p1"], { assignees: ["antinous"] })]);
    const result = await run("claim", "5", "--branch", "fix/5-oars");
    expect([result.code, result.json, writes, posted]).toEqual([1, { claimed: false, issue: 5, reason: "#5 is assigned to 1 account(s)" }, [], []]);
  });

  test("when another owner appears during the claim, nothing is announced and their assignment is left alone", async () => {
    const { run, posted, byNumber } = tracker([issue(5, [...READY, "priority: p1"])], { rival: true });
    const result = await run("claim", "5", "--branch", "fix/5-oars");
    expect([result.code, result.json.reason, posted]).toEqual([1, "another owner appeared while claiming", []]);
    expect(byNumber.get(5)!.assignees).toContain("antinous");
  });

  test("a blocked issue is claimed only after its stack review is declared", async () => {
    const { run } = tracker([issue(5, [...READY, "priority: p1", "blocked"])]);
    expect((await run("claim", "5", "--branch", "fix/5-oars")).json.reason).toBe("#5 is blocked, and no stack-selection review was declared");
    expect((await run("claim", "5", "--branch", "fix/5-oars", "--stack-reviewed")).json.claimed).toBe(true);
  });

  test("a release removes only this account's assignment from an open issue", async () => {
    const { run, byNumber } = tracker([issue(5, READY, { assignees: ["odysseus", "antinous"] }), issue(6, READY, { assignees: ["antinous"] }), issue(7, READY, { assignees: ["odysseus"], state: "closed" })]);
    expect((await run("release", "5")).json).toEqual({ released: true, issue: 5, remainingAssignees: 1 });
    expect(byNumber.get(5)!.assignees).toEqual(["antinous"]);
    expect((await run("release", "6")).json).toMatchObject({ released: false, reason: "this account does not hold it" });
    expect((await run("release", "7")).json).toMatchObject({ released: false, reason: "the issue is closed; its assignment stays as history" });
  });
});

describe("one issue at a glance", () => {
  const body = "Part of the voyage.\n\nBlocked by #2, #3\n";
  const issues = [issue(1, [...READY, "priority: p1", "blocked"], { body, comments: 2, milestone: "0.45.0" }), issue(2, ["type: fix"], { state: "closed", stateReason: "completed", title: "the mast" }),
    issue(3, ["type: fix"], { title: "the sail" }), issue(9, ["epic"], { title: "Epic: the voyage" })];

  test("labels are grouped, blockers carry their live state, and the native parent is read", async () => {
    const { run } = tracker(issues, { parents: { 1: 9 }, prs: [{ number: 900, head: "fix/1-oars", draft: true, body: "" }] });
    expect((await run("show", "1")).json).toMatchObject({ number: 1, state: "open", epic: false, type: ["fix"], area: ["core"], priority: ["p1"], needs: [], other: ["agent-ready", "blocked"],
      milestone: "0.45.0", parent: { number: 9, title: "Epic: the voyage", state: "open" },
      blockers: [{ ref: `${REPO}#2`, state: "closed", reason: "completed", title: "the mast" }, { ref: `${REPO}#3`, state: "open", title: "the sail" }],
      unreadableBlockerLines: [], openPullRequests: [900], comments: 2, bodyChars: body.length, eligible: true });
  });

  test("no parent is an answer; an unreadable blocker is not treated as closed", async () => {
    const { run } = tracker([issue(1, READY, { body: "Blocked by #404\n" })]);
    const shown = (await run("show", "1")).json;
    expect([shown.parent, shown.blockers]).toEqual([null, [{ ref: `${REPO}#404`, state: "unreadable" }]]);
  });

  test("the whole thread goes to a file instead of the output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odysseus-issue-queue-")); scratch.push(dir);
    const { run } = tracker(issues, { comments: { 1: ["First watch.", "Second watch."] } });
    const shown = (await run("show", "1", "--thread", join(dir, "thread.md"))).json;
    expect(shown.thread).toBe(join(dir, "thread.md"));
    expect(readFileSync(join(dir, "thread.md"), "utf8")).toBe(`# #1 issue 1\n\n${body}\n## Comment 1 of 2, 2026-07-12T01:00:00Z, odysseus (OWNER)\n\nFirst watch.\n\n## Comment 2 of 2, 2026-07-12T01:00:00Z, odysseus (OWNER)\n\nSecond watch.\n`);
  });
});
