import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isCorePackagePath, touchesCorePackages } from "../scripts/fast-lane";
import type { Gh } from "../scripts/issue-queue";
import { main, newestReview, parseReview, reviewBlock, reviewComment, reviewFromBody, reviewGate, reviewRefusal, unreviewedCommits,
  REVIEW_END, REVIEW_START, type ReviewFinding, type ReviewRecord } from "../scripts/review-receipt";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const PR = 7, REPO = "odysseus/brain-kit";
const record = (head: string, base: string, findings: ReviewFinding[] = [], reviewer: ReviewRecord["reviewer"] = "agent"): ReviewRecord =>
  ({ version: 1, kind: "brain-review-receipt", pr: PR, head, base, reviewer, outcome: findings.length ? "findings" : "no-findings", findings });

/**
 * A real repository: `main` with one commit and a `raft` branch whose one
 * commit changes a core package. That commit is the reviewed head.
 */
function voyage(path = "packages/core/src/raft.ts") {
  const root = mkdtempSync(join(tmpdir(), "odysseus-review-")); dirs.push(root);
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, `git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`).toBe(0);
    return new TextDecoder().decode(result.stdout).trim();
  };
  const commit = (file: string, text: string, message: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text);
    git("add", "-A"); git("commit", "-qm", message); return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  const start = commit("README.md", "Odysseus sails.\n", "base");
  git("checkout", "-qb", "raft");
  const reviewed = commit(path, "export const raft = 1;\n", "build the raft");
  /** Main gains a commit, as another merged PR would add. */
  const advanceMain = (name: string) => { git("checkout", "-q", "main"); const tip = commit(`docs/${name}.md`, `${name}\n`, `main: ${name}`); git("checkout", "-q", "raft"); return tip; };
  /** The refresh used under lease contention: merge the base into the branch. */
  const mergeMain = () => { git("merge", "-q", "--no-ff", "--no-edit", "main"); return git("rev-parse", "HEAD"); };
  return { root, git, commit, start, reviewed, advanceMain, mergeMain };
}

describe("the record", () => {
  const head = "a".repeat(40), base = "b".repeat(40), fix = "c".repeat(40);
  const full = record(head, base, [{ summary: "The mast is not lashed.", disposition: "fixed", commit: fix },
    { summary: "The oars are uncounted.", disposition: "filed", issue: "odysseus/brain-kit#12" },
    { summary: "The sail is too small.", disposition: "rejected", reason: "The raft carries one man." }]);

  test("round-trips through its comment, and a review with no findings says so explicitly", () => {
    expect(reviewFromBody(reviewComment(full))).toEqual(full);
    expect(reviewFromBody(reviewComment(full).replace(/\n/g, "\r\n"))).toEqual(full);
    const none = record(head, base);
    expect(none.outcome).toBe("no-findings");
    expect(reviewComment(none)).toContain("Reviewer: agent. No findings.");
    expect(reviewComment(full)).toContain("3 findings: 1 fixed, 1 filed, 1 rejected, 0 without a disposition.");
    // A summary's own words stay inside the code fence: outside it, a mention would notify someone.
    const mention = reviewComment(record(head, base, [{ summary: "@odysseus left #12 open." }]));
    expect(mention.slice(0, mention.indexOf(REVIEW_START)), "FINDING_TEXT_ONLY_IN_THE_FENCE").not.toContain("@odysseus");
    expect(reviewFromBody(mention)?.findings).toEqual([{ summary: "@odysseus left #12 open." }]);
    expect(() => parseReview({ ...none, outcome: "findings" }), "EMPTY_LIST_IS_NOT_A_STATEMENT").toThrow("no-findings exactly when");
    expect(() => parseReview({ ...full, outcome: "no-findings" })).toThrow("no-findings exactly when");
  });

  test("names the reviewer only as agent or human, and refuses any other identity field", () => {
    expect(parseReview(record(head, base, [], "human")).reviewer).toBe("human");
    expect(() => parseReview({ ...full, reviewer: "Odysseus" }), "REVIEWER_KIND_ONLY").toThrow("Invalid review record");
    expect(() => parseReview({ ...full, reviewerName: "Odysseus" }), "NO_EXTRA_RECORD_FIELD").toThrow("Invalid review record");
    expect(() => parseReview({ ...full, findings: [{ summary: "The mast is not lashed.", author: "Odysseus" }] }), "NO_EXTRA_FINDING_FIELD").toThrow("Invalid review finding");
    expect(Object.keys(JSON.parse(/```json\n([\s\S]*)\n```/.exec(reviewBlock(full))![1]!)).sort()).toEqual(["base", "findings", "head", "kind", "outcome", "pr", "reviewer", "version"]);
  });

  test("gives each finding at most one disposition, with exactly the detail that disposition names", () => {
    const bad = (finding: object) => () => parseReview({ ...full, findings: [finding] });
    expect(parseReview({ ...full, findings: [{ summary: "The mast is not lashed." }] }).findings).toHaveLength(1);
    expect(bad({ summary: "x", disposition: "fixed" })).toThrow("Invalid review finding");
    expect(bad({ summary: "x", disposition: "fixed", commit: "c0ffee" })).toThrow("Invalid review finding commit");
    expect(bad({ summary: "x", disposition: "fixed", commit: fix, reason: "also rejected" })).toThrow("Invalid review finding");
    expect(bad({ summary: "x", disposition: "filed", issue: "#12" })).toThrow("Invalid review finding issue");
    expect(bad({ summary: "x", disposition: "rejected", reason: " " })).toThrow("Invalid review finding reason");
    expect(bad({ summary: "x", disposition: "wontfix", reason: "no" })).toThrow("Invalid review finding");
    expect(bad({ summary: "two\nlines" })).toThrow("Invalid review finding");
  });

  test("only the newest record counts, and an unreadable newest record never falls back to an older one", () => {
    const older = reviewComment(record(head, base)), newer = reviewComment(record(fix, base));
    expect(newestReview([])).toBeNull();
    expect(newestReview(["Odysseus builds a raft.", null])).toBeNull();
    expect(newestReview([older, "A later remark.", newer, "The last word."])?.head).toBe(fix);
    expect(() => newestReview([older, `${REVIEW_START}\n\`\`\`json\n{"version":2}\n\`\`\`\n${REVIEW_END}`]), "NO_FALLBACK_TO_OLDER").toThrow("Invalid review record");
    expect(() => newestReview([older, `${REVIEW_START}\n${REVIEW_END}`])).toThrow("empty");
    expect(() => newestReview([older + "\n" + newer])).toThrow("more than one");
    expect(() => newestReview([REVIEW_START])).toThrow("Unterminated");
  });
});

describe("one path predicate decides the fast lane and the review", () => {
  test("only the four core packages count, by directory", () => {
    for (const path of ["packages/core/src/index.ts", "packages/ui-react/tests/a.test.tsx", "packages/ui-kit/package.json", "packages/ui-server/src/routes/x.ts"]) expect(isCorePackagePath(path), path).toBe(true);
    for (const path of ["packages/core-extras/src/index.ts", "packages/ui-sdk/src/index.ts", "docs/packages/core/x.md", "scripts/core/x.ts", "packages/core"]) expect(isCorePackagePath(path), path).toBe(false);
    expect(touchesCorePackages(["docs/voyage.md", "packages/ui-kit/src/sail.css"])).toBe(true);
    expect(touchesCorePackages(["docs/voyage.md", "scripts/integrate.ts"])).toBe(false);
  });

  test("a PR outside the four packages is never asked for a review: its comments are not even read", async () => {
    const { root, reviewed, start } = voyage("packages/common/src/raft.ts");
    const asked = () => { throw new Error("NEVER_ASKED: comments were read for a PR outside the core packages"); };
    expect(await reviewGate(root, { pr: PR, head: reviewed, base: start }, asked)).toBeNull();
  });

  test("a core-package PR with no record is refused with the command that fixes it", async () => {
    const { root, reviewed, start } = voyage();
    const refusal = await reviewGate(root, { pr: PR, head: reviewed, base: start }, async () => ["Odysseus builds a raft."]);
    expect(refusal, "CORE_PR_WITHOUT_RECORD_REFUSED").toContain("No review record on PR #7");
    expect(refusal).toContain("bun scripts/review-receipt.ts post 7 --reviewer <agent|human> --head <reviewed-sha>");
    expect(refusal).toContain("a fresh agent context or a human");
  });

  test("moving a file out of a core package still touches it", async () => {
    const { root, git, reviewed } = voyage();
    git("mv", "packages/core/src/raft.ts", "raft.ts"); git("commit", "-qm", "beach the raft");
    const refusal = await reviewGate(root, { pr: PR, head: git("rev-parse", "HEAD"), base: reviewed }, async () => []);
    expect(refusal, "RENAME_SOURCE_COUNTS").toContain("No review record");
  });
});

describe("which commits a record covers, against real Git history", () => {
  test("a record at an older head still admits a candidate whose only newer commits are merges of the base", () => {
    const { root, git, reviewed, start, advanceMain, mergeMain } = voyage();
    const comments = [reviewComment(record(reviewed, start))];
    advanceMain("Scylla"); mergeMain();
    const base = advanceMain("Charybdis"), head = mergeMain();
    // The control: the head really moved, by two merge commits and main's two commits.
    expect(head).not.toBe(reviewed);
    expect(git("rev-list", "--merges", head, `^${base}`).split("\n")).toHaveLength(2);
    expect(git("rev-list", "--count", `${reviewed}..${head}`)).toBe("4");
    expect(unreviewedCommits(root, { pr: PR, head, base }, reviewed)).toEqual([]);
    expect(reviewRefusal(root, { pr: PR, head, base }, comments), "RECORD_SURVIVES_BASE_MERGE").toBeNull();
  });

  test("a new non-merge commit after the reviewed head refuses, also behind a later merge of the base", () => {
    const { root, commit, reviewed, start, advanceMain, mergeMain } = voyage();
    const comments = [reviewComment(record(reviewed, start))];
    advanceMain("Scylla"); mergeMain();
    const added = commit("packages/core/src/oar.ts", "export const oar = 1;\n", "carve an oar");
    const base = advanceMain("Charybdis"), head = mergeMain();
    expect(unreviewedCommits(root, { pr: PR, head, base }, reviewed), "NEW_COMMIT_IS_UNREVIEWED").toEqual([added]);
    const refusal = reviewRefusal(root, { pr: PR, head, base }, comments)!;
    expect(refusal, "NEW_COMMIT_NEEDS_REVIEW").toContain(`contains 1 commit the reviewed head ${reviewed} does not (${added.slice(0, 12)})`);
    expect(refusal).toContain("bun scripts/review-receipt.ts post 7");
    // A review of the new head covers it.
    expect(reviewRefusal(root, { pr: PR, head, base }, [...comments, reviewComment(record(head, base))])).toBeNull();
  });

  test("a rebase rewrites the reviewed commits, so the old record no longer covers the branch", () => {
    const { root, git, reviewed, start, advanceMain } = voyage();
    const base = advanceMain("Scylla");
    git("rebase", "-q", "main");
    const head = git("rev-parse", "HEAD");
    expect(git("diff", "--name-only", reviewed, head)).toBe("docs/Scylla.md");
    expect(reviewRefusal(root, { pr: PR, head, base }, [reviewComment(record(reviewed, start))]), "REBASE_NEEDS_REVIEW").toContain("a new commit, a rebase or an amend needs a new review");
  });

  test("merging another branch brings its commits with it: the merge commit does not hide them", () => {
    const { root, git, commit, reviewed, start } = voyage();
    git("checkout", "-qb", "sirens", start);
    const song = commit("packages/ui-server/src/song.ts", "export const song = 1;\n", "the sirens sing");
    git("checkout", "-q", "raft"); git("merge", "-q", "--no-ff", "--no-edit", "sirens");
    const head = git("rev-parse", "HEAD");
    expect(reviewRefusal(root, { pr: PR, head, base: start }, [reviewComment(record(reviewed, start))]), "MERGED_BRANCH_COMMITS_COUNT").toContain(song.slice(0, 12));
  });

  test("a reviewed head that cannot be read cannot establish what was added since", () => {
    const { root, reviewed, start } = voyage();
    expect(reviewRefusal(root, { pr: PR, head: reviewed, base: start }, [reviewComment(record("d".repeat(40), start))])).toContain("can be neither read nor fetched");
  });
});

describe("dispositions", () => {
  test("an undisposed finding in the newest record refuses and is named", () => {
    const { root, reviewed, start } = voyage(), candidate = { pr: PR, head: reviewed, base: start };
    const open = reviewComment(record(reviewed, start, [{ summary: "The mast is not lashed." }, { summary: "The sail is too small.", disposition: "rejected", reason: "The raft carries one man." }]));
    const refusal = reviewRefusal(root, candidate, [open])!;
    expect(refusal, "UNDISPOSED_FINDING_REFUSES").toContain('leaves 1 finding without a disposition: "The mast is not lashed."');
    expect(refusal).toContain("fixed (naming the commit), filed (naming the issue) or rejected (with the reason)");
    // An older clean record does not rescue a newer one with an open finding.
    expect(reviewRefusal(root, candidate, [reviewComment(record(reviewed, start)), open])).toContain("without a disposition");
    const answered = reviewComment(record(reviewed, start, [{ summary: "The mast is not lashed.", disposition: "filed", issue: "odysseus/brain-kit#12" },
      { summary: "The sail is too small.", disposition: "rejected", reason: "The raft carries one man." }]));
    expect(reviewRefusal(root, candidate, [open, answered]), "ANSWERED_RECORD_ADMITS").toBeNull();
  });

  test("a finding answered as fixed names a commit the candidate head contains", () => {
    const { root, git, commit, reviewed, start } = voyage();
    const fixed = (sha: string) => [reviewComment(record(reviewed, start, [{ summary: "The mast is not lashed.", disposition: "fixed", commit: sha }]))];
    expect(reviewRefusal(root, { pr: PR, head: reviewed, base: start }, fixed(reviewed))).toBeNull();
    expect(reviewRefusal(root, { pr: PR, head: reviewed, base: start }, fixed("e".repeat(40))), "FIX_COMMIT_MUST_EXIST").toContain("which the candidate head");
    git("checkout", "-qb", "elsewhere", start);
    const stray = commit("docs/elsewhere.md", "Elsewhere.\n", "a fix on another branch");
    expect(reviewRefusal(root, { pr: PR, head: reviewed, base: start }, fixed(stray)), "FIX_COMMIT_MUST_BE_IN_HEAD").toContain("does not contain");
  });

  test("a record written for another pull request does not count", () => {
    const { root, reviewed, start } = voyage();
    expect(reviewRefusal(root, { pr: 8, head: reviewed, base: start }, [reviewComment(record(reviewed, start))])).toContain("names PR #7");
  });
});

describe("the command", () => {
  function github(reviewed: string, base: string, comments: string[] = []) {
    const posted: string[] = [], calls: string[][] = [];
    const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
    const gh: Gh = args => {
      calls.push(args);
      if (args[0] === "api" && args[1] === `repos/${REPO}/pulls/7`) return ok(JSON.stringify({ state: "open", head: { sha: reviewed }, base: { ref: "main", sha: base } }));
      if (args[0] === "api" && args[1] === `repos/${REPO}/git/ref/heads/main`) return ok(`${base}\n`);
      if (args[0] === "api" && args[1] === `repos/${REPO}/issues/7/comments`) return ok(comments.map(body => JSON.stringify(body)).join("\n"));
      if (args[0] === "pr" && args[1] === "comment" && args[2] === "7") { posted.push(readFileSync(args[args.indexOf("--body-file") + 1]!, "utf8")); return ok(""); }
      return { code: 1, stdout: "", stderr: `unexpected gh ${args.join(" ")}` };
    };
    return { gh, posted, calls };
  }
  async function run(gh: Gh, root: string, ...argv: string[]) {
    const out: string[] = [];
    const code = await main([...argv, "--repo", REPO], { gh, out: text => out.push(text), root });
    return { code, out: out.join("\n") };
  }
  const findingsFile = (root: string, findings: unknown) => { const file = join(root, "findings.json"); writeFileSync(file, JSON.stringify(findings)); return file; };

  test("post writes one comment whose block the gate accepts, and a no-findings review says so", async () => {
    const { root, reviewed, start } = voyage(), { gh, posted } = github(reviewed, start);
    const result = await run(gh, root, "post", "7", "--reviewer", "agent", "--head", reviewed, "--no-findings");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ posted: true, pr: 7, head: reviewed, base: start, reviewer: "agent", findings: 0, undisposed: 0 });
    expect(posted).toHaveLength(1);
    expect(reviewFromBody(posted[0])).toEqual(record(reviewed, start));
    expect(reviewRefusal(root, { pr: PR, head: reviewed, base: start }, posted)).toBeNull();
  });

  test("the comment passes the leakage gate before it is posted", async () => {
    const { root, reviewed, start } = voyage(), { gh, posted, calls } = github(reviewed, start);
    // Assembled from parts, so this file does not carry a string the gate refuses.
    const personal = ["wyv", "ern"].join("");
    const file = findingsFile(root, [{ summary: `The mast was lashed on ${personal}.`, disposition: "rejected", reason: "Out of scope." }]);
    await expect(run(gh, root, "post", "7", "--reviewer", "human", "--head", reviewed, "--findings", file)).rejects.toThrow("leakage gate refuses; nothing was posted");
    expect(posted, "NOTHING_POSTED_AFTER_LEAKAGE_REFUSAL").toEqual([]);
    expect(calls.some(args => args[0] === "pr"), "NO_COMMENT_CALL").toBe(false);
    // The control: the same finding without the personal string is posted.
    writeFileSync(file, JSON.stringify([{ summary: "The mast was lashed on Ithaca.", disposition: "rejected", reason: "Out of scope." }]));
    expect((await run(gh, root, "post", "7", "--reviewer", "human", "--head", reviewed, "--findings", file)).code).toBe(0);
    expect(posted).toHaveLength(1);
  });

  test("post refuses a reviewer identity, an unanswerable shape and a silent empty review; --dry-run posts nothing", async () => {
    const { root, reviewed, start } = voyage(), { gh, posted } = github(reviewed, start);
    await expect(run(gh, root, "post", "7", "--reviewer", "Odysseus", "--head", reviewed, "--no-findings")).rejects.toThrow("--reviewer is agent or human");
    await expect(run(gh, root, "post", "7", "--reviewer", "agent", "--head", "raft", "--no-findings")).rejects.toThrow("--head needs the full reviewed commit SHA");
    await expect(run(gh, root, "post", "7", "--reviewer", "agent", "--head", reviewed)).rejects.toThrow("exactly one of --no-findings and --findings");
    await expect(run(gh, root, "post", "7", "--reviewer", "agent", "--head", reviewed, "--findings", findingsFile(root, []))).rejects.toThrow("use --no-findings");
    await expect(run(gh, root, "post", "7", "--reviewer", "agent", "--head", reviewed, "--findings", findingsFile(root, [{ summary: "x", reviewer: "Odysseus" }]))).rejects.toThrow("Invalid review finding");
    const open = findingsFile(root, [{ summary: "The mast is not lashed." }]);
    const outside = mkdtempSync(join(tmpdir(), "odysseus-review-findings-")); dirs.push(outside);
    const dry = await run(gh, root, "post", "7", "--reviewer", "agent", "--head", reviewed, "--findings", open, "--dry-run");
    expect(dry.out).toContain("1 finding: 0 fixed, 0 filed, 0 rejected, 1 without a disposition.");
    await expect(run(gh, root, "post", "7", "--reviewer", "agent", "--head", reviewed, "--findings", findingsFile(outside, [{ summary: `The block ends at ${REVIEW_END} too early.` }])),
      "UNREADABLE_COMMENT_NEVER_POSTED").rejects.toThrow("does not read back from its own comment");
    expect(posted).toEqual([]);
    // An unanswered review can be recorded as it stands; the gate refuses it until it is answered.
    const recorded = await run(gh, root, "post", "7", "--reviewer", "agent", "--head", reviewed, "--findings", open);
    expect(JSON.parse(recorded.out)).toMatchObject({ posted: true, findings: 1, undisposed: 1 });
    expect(reviewRefusal(root, { pr: PR, head: reviewed, base: start }, posted)).toContain("without a disposition");
  });

  test("check prints the gate's decision for the live head and exits 1 on a refusal", async () => {
    const { root, reviewed, start } = voyage();
    const refused = await run(github(reviewed, start).gh, root, "check", "7");
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.out)).toMatchObject({ pr: 7, head: reviewed, base: start, required: true, record: null, refusal: expect.stringContaining("No review record") });
    const admitted = await run(github(reviewed, start, [reviewComment(record(reviewed, start, [], "human"))]).gh, root, "check", "7");
    expect(admitted.code).toBe(0);
    expect(JSON.parse(admitted.out)).toEqual({ pr: 7, head: reviewed, base: start, required: true, record: { head: reviewed, reviewer: "human", findings: 0, undisposed: 0 }, refusal: null });
    const outside = voyage("packages/common/src/raft.ts"), other = github(outside.reviewed, outside.start);
    const unasked = await run(other.gh, outside.root, "check", "7");
    expect(JSON.parse(unasked.out)).toMatchObject({ required: false, record: null, refusal: null });
    expect(other.calls.some(args => args.join(" ").includes("/comments")), "COMMENTS_NOT_READ_OUTSIDE_CORE").toBe(false);
  });
});
