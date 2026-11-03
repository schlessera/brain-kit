import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GitReservationStore } from "../scripts/integration-reservation";
import { attachIncident, CLAIM_TERM_MS, claimFix, emptyRedMain, openRed, parseRedMain, releaseFixClaim, renewFixClaim, type RedMainRecord } from "../scripts/red-main";
import { claimIncident, evidenceMarker, formatEvidence, postEvidence, type IncidentIO } from "../scripts/red-main-incident";
import type { Snapshot } from "../scripts/red-main-coordinator";

const ROOT = resolve(import.meta.dir, "..");
const FIXTURE = join(ROOT, "tests/fixtures/red-main-incident/record.json");
const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const NOW = Date.parse("2026-07-12T00:00:00Z"), B = "b".repeat(40);
const PENELOPE = { worker: "wi-20260712-penelope", orchestrator: "orch-ithaca" };
const TELEMACHUS = { worker: "wi-20260712-telemachus", orchestrator: "orch-pylos" };

function redWithIncident(): RedMainRecord {
  const red = openRed(emptyRedMain(), { firstBad: B, run: 100, failures: [{ test: "packages/core/tests/raft.test.ts", category: "unit", verdict: "real", reasons: ["in-affected-closure"], run: 100, sha: B }] }, NOW);
  return attachIncident(red, 500, NOW + 1000);
}

/** In-memory record store plus a fake issue API that records every write. */
function fakeIssues(record: RedMainRecord, start = NOW + 2000) {
  let snapshot: Snapshot = { oid: "0", redMain: record }, version = 0, clock = start;
  const writes: { method: string; path: string; body: any }[] = [];
  const io: IncidentIO = {
    repository: "odysseus/brain-kit", login: "odysseus",
    read: () => snapshot,
    publish(seen, next) { if (seen.oid !== String(version)) return false; snapshot = { oid: String(++version), redMain: parseRedMain(JSON.stringify(next)) }; return true; },
    now: async () => clock,
    async json(path) {
      const match = /issues\/(\d+)\/comments/.exec(path);
      if (match) return writes.filter(w => w.method === "POST" && w.path.endsWith(`/issues/${match[1]}/comments`)).map(w => ({ body: w.body.body }));
      throw new Error(`Unexpected offline API ${path}`);
    },
    async write(method, path, body) { writes.push({ method, path, body }); return {}; },
  };
  return { io, writes, record: () => snapshot.redMain, at: (ms: number) => { clock = ms; },
    comments: (issue: number) => writes.filter(w => w.method === "POST" && w.path === `repos/odysseus/brain-kit/issues/${issue}/comments`).map(w => w.body.body as string) };
}

describe("fix claim record", () => {
  test("records without a claim still parse, a malformed claim is refused, and claims need a filed incident", () => {
    const legacy = redWithIncident();
    expect(Object.hasOwn(legacy.open!, "claim")).toBe(false);
    expect(parseRedMain(JSON.stringify(legacy))).toEqual(legacy);
    const claimed = claimFix(legacy, PENELOPE, NOW + 2000);
    expect(parseRedMain(JSON.stringify(claimed))).toEqual(claimed);
    expect(claimed.open!.claim).toEqual({ ...PENELOPE, claimed: NOW + 2000, renewed: NOW + 2000, expires: NOW + 2000 + CLAIM_TERM_MS, takeover: null });
    const tamper = (claim: unknown) => JSON.stringify({ ...claimed, open: { ...claimed.open, claim } });
    expect(() => parseRedMain(tamper({ ...claimed.open!.claim, expires: NOW + 10 * CLAIM_TERM_MS })), "CLAIM_TERM_IS_FIXED").toThrow("Invalid red-main fix claim");
    expect(() => parseRedMain(tamper({ ...claimed.open!.claim, worker: "Odysseus of Ithaca" }))).toThrow("Invalid red-main fix claim");
    expect(() => parseRedMain(tamper({ ...claimed.open!.claim, extra: 1 }))).toThrow("Invalid red-main fix claim");
    expect(() => parseRedMain(tamper("penelope"))).toThrow("Invalid red-main fix claim");
    expect(parseRedMain(tamper(null)).open!.claim).toBeNull();
    const pending = openRed(emptyRedMain(), { firstBad: B, run: 100, failures: legacy.open!.failures }, NOW);
    expect(() => claimFix(pending, PENELOPE, NOW + 1)).toThrow("Incident pending");
    expect(() => claimFix(emptyRedMain(), PENELOPE, NOW)).toThrow("Main is not red");
  });

  test("a live claim refuses others, renews for its owner, and is released only by its owner", () => {
    let record = claimFix(redWithIncident(), PENELOPE, NOW + 2000);
    expect(() => claimFix(record, TELEMACHUS, NOW + 3000)).toThrow("Fix claimed by worker wi-20260712-penelope");
    expect(() => renewFixClaim(record, TELEMACHUS, NOW + 3000)).toThrow("no live fix claim");
    expect(() => releaseFixClaim(record, TELEMACHUS, NOW + 3000)).toThrow("does not hold the fix claim");
    record = claimFix(record, PENELOPE, NOW + 5000);
    expect(record.last?.action).toBe("renew-claim");
    expect(record.open!.claim).toMatchObject({ claimed: NOW + 2000, renewed: NOW + 5000, expires: NOW + 5000 + CLAIM_TERM_MS });
    expect(() => renewFixClaim(record, PENELOPE, NOW + 5000 + CLAIM_TERM_MS)).toThrow("no live fix claim");
    record = releaseFixClaim(record, PENELOPE, NOW + 6000);
    expect(record.open!.claim).toBeNull();
    expect(claimFix(record, TELEMACHUS, NOW + 7000).open!.claim).toMatchObject({ ...TELEMACHUS, takeover: null });
  });
});

describe("claiming the incident", () => {
  test("two orchestrators claiming concurrently through the shared ref produce exactly one claim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "odysseus-red-main-claim-")); scratch.push(dir);
    const git = (cwd: string, ...args: string[]) => {
      const p = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env,
        GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@example.invalid", GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@example.invalid",
        GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
      expect(p.exitCode, new TextDecoder().decode(p.stderr)).toBe(0);
    };
    const remote = join(dir, "remote.git"); git(dir, "init", "--bare", remote);
    for (const name of ["seed", "one", "two"]) { mkdirSync(join(dir, name)); git(join(dir, name), "init"); git(join(dir, name), "remote", "add", "origin", remote); }
    const seed = new GitReservationStore(join(dir, "seed"));
    expect(seed.publishRedMain(seed.read(), redWithIncident())).toBe(true);
    const script = join(dir, "orchestrator.ts");
    // Both orchestrators read the same coordination commit before either writes;
    // the second pushes only after the first has, so its push races a moved ref.
    writeFileSync(script, `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
      import { GitReservationStore } from ${JSON.stringify(join(ROOT, "scripts/integration-reservation.ts"))};
      import { claimIncident } from ${JSON.stringify(join(ROOT, "scripts/red-main-incident.ts"))};
      const [root, number, barrier, log] = process.argv.slice(2), store = new GitReservationStore(root);
      let reads = 0;
      const io = { repository: "odysseus/brain-kit", login: "odysseus",
        read() { const snapshot = store.read(); if (reads++ === 0) { writeFileSync(barrier + number, "ready"); while (!existsSync(barrier + "1") || !existsSync(barrier + "2")) Bun.sleepSync(5); } return snapshot; },
        publish(snapshot, record) {
          if (number === "2") while (!existsSync(barrier + "published")) Bun.sleepSync(5);
          const pushed = store.publishRedMain(snapshot, record); appendFileSync(log, JSON.stringify({ number, pushed }) + "\\n");
          if (number === "1") writeFileSync(barrier + "published", "done");
          return pushed;
        },
        now: async () => ${NOW + 2000} + Number(number), json: async () => [],
        async write(method, path, body) { appendFileSync(log, JSON.stringify({ number, method, path }) + "\\n"); return {}; } };
      try { const result = await claimIncident(io, { worker: "wi-" + number, orchestrator: "orch-" + number }, "claim"); console.log(JSON.stringify({ claimed: true, action: result.action })); }
      catch (error) { console.log(JSON.stringify({ claimed: false, error: String(error) })); }`);
    const log = join(dir, "log.jsonl");
    const children = ["1", "2"].map((id, index) => Bun.spawn([process.execPath, script, join(dir, index ? "two" : "one"), id, join(dir, "barrier-"), log], { stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(children.map(async child => {
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, err).toBe(0); return JSON.parse(out) as { claimed: boolean; action?: string; error?: string };
    }));
    expect(results.map(r => r.claimed), "EXACTLY_ONE_CLAIM_SUCCEEDS").toEqual([true, false]);
    expect(results[1]!.error).toContain("Fix claimed by worker wi-1 (orchestrator orch-1)");
    const events = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    // The loser's push really reached the remote and was rejected by the compare-and-swap.
    expect(events.filter(e => "pushed" in e)).toEqual([{ number: "1", pushed: true }, { number: "2", pushed: false }]);
    expect(events.filter(e => e.method).map(e => `${e.number} ${e.method} ${e.path}`), "ONLY_THE_WINNER_MIRRORS").toEqual([
      "1 POST repos/odysseus/brain-kit/issues/500/assignees", "1 POST repos/odysseus/brain-kit/issues/500/comments"]);
    expect(new GitReservationStore(join(dir, "two")).read().redMain.open!.claim).toMatchObject({ worker: "wi-1", orchestrator: "orch-1" });
  });

  test("an expired claim is taken over and the takeover is recorded on the issue", async () => {
    const gh = fakeIssues(redWithIncident());
    const first = await claimIncident(gh.io, PENELOPE, "claim");
    expect(first.mirrored).toEqual(["assignee", "claim-comment"]);
    gh.at(NOW + 2000 + CLAIM_TERM_MS - 1);
    await expect(claimIncident(gh.io, TELEMACHUS, "claim")).rejects.toThrow("Fix claimed by worker wi-20260712-penelope");
    gh.at(NOW + 2000 + CLAIM_TERM_MS);
    const takeover = await claimIncident(gh.io, TELEMACHUS, "claim");
    expect(takeover.action).toBe("takeover");
    expect(gh.record().open!.claim).toMatchObject({ ...TELEMACHUS, takeover: { ...PENELOPE, expired: NOW + 2000 + CLAIM_TERM_MS } });
    const comments = gh.comments(500);
    expect(comments).toHaveLength(2);
    expect(comments[1], "TAKEOVER_ON_ISSUE").toContain("**Fix claim takeover**: worker `wi-20260712-telemachus` (orchestrator `orch-pylos`) took over the fix from worker `wi-20260712-penelope` (orchestrator `orch-ithaca`), whose claim expired at 2026-07-12T01:00:02.000Z.");
    expect(gh.writes.filter(w => w.path.endsWith("/assignees")).map(w => w.body)).toEqual([{ assignees: ["odysseus"] }, { assignees: ["odysseus"] }]);
    // The previous claimant can no longer renew, and claiming again only renews, mirrored once.
    await expect(claimIncident(gh.io, PENELOPE, "renew")).rejects.toThrow("no live fix claim");
    expect((await claimIncident(gh.io, TELEMACHUS, "claim")).mirrored).toEqual(["assignee"]);
    expect(gh.comments(500)).toHaveLength(2);
    const released = await claimIncident(gh.io, TELEMACHUS, "release");
    expect(released.claim).toBeNull();
    expect(gh.comments(500)[2]).toContain("**Fix claim released** by worker `wi-20260712-telemachus`");
    expect(gh.writes.at(-1)).toMatchObject({ method: "DELETE", path: "repos/odysseus/brain-kit/issues/500/assignees" });
  });
});

describe("evidence", () => {
  test("a non-claimant posts evidence in the fixed format to the one incident and opens nothing", async () => {
    const fixture = parseRedMain(readFileSync(FIXTURE, "utf8"));
    const gh = fakeIssues(fixture, NOW + 600_000);
    const result = await postEvidence(gh.io, { ...TELEMACHUS, kind: "reproduction", sha: B, summary: "raft.test.ts fails at the first bad SHA on a clean checkout", details: "expect(received).toBe(expected)\n```nested```" });
    expect(result).toMatchObject({ incident: 500, role: "contributor" });
    expect(gh.writes.map(w => `${w.method} ${w.path}`), "NO_SECOND_INCIDENT").toEqual(["POST repos/odysseus/brain-kit/issues/500/comments"]);
    expect(gh.record()).toBe(fixture);
    expect(result.body.split("\n").slice(0, 8)).toEqual([evidenceMarker(100, "reproduction"), "### Red-main evidence: reproduction", "",
      "- **Incident:** main red at `bbbbbbbbbbbb` (record run 100)", "- **From:** worker `wi-20260712-telemachus`, orchestrator `orch-pylos` (contributor)",
      `- **SHA:** \`${B}\``, "- **Summary:** raft.test.ts fails at the first bad SHA on a clean checkout", ""]);
    expect(result.body).toContain("````text\nexpect(received).toBe(expected)\n```nested```\n````");
    expect(formatEvidence(fixture.open!, { ...PENELOPE, kind: "bisect", summary: "x" }, "claimant")).toContain("(claimant)");
    // A duplicate is linked on the incident and pointed at it, never filed again.
    await postEvidence(gh.io, { ...TELEMACHUS, kind: "duplicate", issue: 321, summary: "the same raft failure was filed separately" });
    expect(gh.writes.slice(1).map(w => w.path)).toEqual(["repos/odysseus/brain-kit/issues/500/comments", "repos/odysseus/brain-kit/issues/321/comments"]);
    expect(gh.writes[2]!.body.body).toContain("tracked by red-main incident #500");
    await expect(postEvidence(gh.io, { ...TELEMACHUS, kind: "related", summary: "no issue" })).rejects.toThrow("--issue is required");
    // The claimant's recovery choice is recorded with its rationale; uncertainty stays explicit.
    const decision = await postEvidence(gh.io, { ...PENELOPE, kind: "decision", choice: "revert", sha: B, summary: "revert the squash at the first bad SHA; the bisect probe isolates it and later squashes do not depend on it",
      details: "Cause: probe reproduced at the first bad SHA and passed at its parent.\nDependencies: no later squash touches the reverted files." });
    expect(decision.role).toBe("claimant");
    expect(decision.body, "DECISION_RECORDS_CHOICE").toContain("- **Choice:** targeted revert PR");
    expect(decision.body).toContain("Cause: probe reproduced");
    expect(formatEvidence(fixture.open!, { ...PENELOPE, kind: "decision", choice: "uncertain", summary: "x" }, "claimant")).toContain("uncertain: neither a fix nor a revert is supportable yet");
    await expect(postEvidence(gh.io, { ...PENELOPE, kind: "decision", summary: "no choice", details: "why" })).rejects.toThrow("--choice is required");
    await expect(postEvidence(gh.io, { ...PENELOPE, kind: "decision", choice: "fix", summary: "no rationale" })).rejects.toThrow("causal and current-tree rationale");
    await expect(postEvidence(gh.io, { ...PENELOPE, kind: "log", choice: "fix", summary: "stray choice" })).rejects.toThrow("--choice is required");
    await expect(postEvidence(gh.io, { ...TELEMACHUS, kind: "log", summary: "two\nlines" })).rejects.toThrow("one-line summary");
    await expect(postEvidence(fakeIssues(emptyRedMain()).io, { ...TELEMACHUS, kind: "log", summary: "late" })).rejects.toThrow("Main is not red");
  });

  test("the CLI dry run against the fixture incident posts evidence, refuses the second claim and writes nothing else", () => {
    const cli = (...args: string[]) => {
      const p = Bun.spawnSync([process.execPath, "scripts/red-main-incident.ts", ...args, "--dry-run", "--record", FIXTURE, "--repository", "odysseus/brain-kit", "--now", "2026-07-12T00:10:00Z",
        "--worker", TELEMACHUS.worker, "--orchestrator", TELEMACHUS.orchestrator], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: "" } });
      return { code: p.exitCode, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
    };
    const evidence = cli("evidence", "--kind", "ruled-out", "--summary", "not the shared fixture clock: the failure reproduces with it pinned");
    expect(evidence.code, evidence.err).toBe(0);
    const writes = evidence.out.split("\n").filter(line => line.startsWith("DRY_RUN"));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toStartWith("DRY_RUN POST repos/odysseus/brain-kit/issues/500/comments ");
    expect(writes[0]).toContain("(contributor)");
    expect(evidence.out).toContain('{"evidence":true,"incident":500,"role":"contributor","dryRun":true}');
    const claim = cli("claim");
    expect(claim.code).toBe(1);
    expect(claim.out).toBe("");
    expect(claim.err).toContain("Fix claimed by worker wi-20260712-penelope (orchestrator orch-ithaca) until 2026-07-12T01:01:00.000Z; add evidence to incident #500 instead");
  });
});
