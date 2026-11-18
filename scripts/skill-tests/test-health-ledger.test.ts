import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LENS_IDS, type LensId, type LensVerdict } from "../test-health/catalog";
import { DirLedgerStore, GitLedgerStore, landedOrPending, ledgerState, monthFile, parseRecords,
  type BatchRecord, type ClaimRecord, type ClusterRecord, type LedgerRecord, type RunRecord } from "../test-health/ledger";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = (name: string) => { const dir = mkdtempSync(join(tmpdir(), `odysseus-${name}-`)); scratch.push(dir); return dir; };

const ENV = { ...process.env, GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@example.invalid",
  GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: ENV });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

const OARS = "packages/ithaca/tests/oars.test.ts";
const SAILS = "packages/ithaca/tests/sails.test.ts";
const REF = "refs/heads/brain-test-health";
const lenses = Object.fromEntries(LENS_IDS.map(lens => [lens, "clean"])) as Record<LensId, LensVerdict>;
const at = (day: number, hour = 0) => new Date(Date.UTC(2026, 6, day, hour)).toISOString();

const claim = (runId: string, files: string[], when: string, expiresAt: string): ClaimRecord =>
  ({ v: 1, type: "claim", at: when, runId, files, expiresAt, profile: "cron" });
const run = (runId: string, when: string): RunRecord =>
  ({ v: 1, type: "run", at: when, runId, agent: "argus", profile: "cron", mode: "hot", package: "ithaca", startedAt: when, outcome: "completed" });
const cluster = (runId: string, index: number, when: string, files: string[], batchId: string | null = null, changed = false): ClusterRecord => ({
  v: 1, type: "cluster", at: when, runId, cluster: index, batchId, commit: changed ? "c".repeat(40) : null, package: "ithaca",
  worksheet: { schemaVersion: 1, runId, cluster: index, seed: files[0]!, members: files, context: [], audits: files.map(file => ({ file, lenses })), findings: [] },
  audits: files.map(file => ({ file, blobBefore: "a".repeat(40), blobAfter: changed ? "b".repeat(40) : "a".repeat(40), lenses })),
});
const batch = (event: BatchRecord["event"], batchId: string, when: string, extra: Partial<BatchRecord> = {}): BatchRecord =>
  ({ v: 1, type: "batch", event, at: when, runId: "th-1", batchId, ...extra });

describe("reading ledger text", () => {
  test("a record of an unknown type is skipped, so an older reader survives a newer writer", () => {
    const lines = [JSON.stringify(run("th-1", at(12))), JSON.stringify({ v: 1, type: "prophecy", at: at(12), runId: "th-1" })].join("\n");
    expect(parseRecords(lines).map(record => record.type)).toEqual(["run"]);
  });

  test("a line that is not a record names its position", () => {
    expect(() => parseRecords(`${JSON.stringify(run("th-1", at(12)))}\n{"type":"run"}\n`, "2026-07.jsonl")).toThrow("2026-07.jsonl:2: a record needs type, at and runId");
    expect(() => parseRecords("not json\n", "2026-07.jsonl")).toThrow("2026-07.jsonl:1: not a JSON line");
  });
});

describe("the state folded from records", () => {
  const now = new Date(at(12, 12));

  test("a claim holds its files until it expires, is released, or its run is recorded", () => {
    const live = claim("th-live", [OARS], at(12, 10), at(12, 13));
    const expired = claim("th-old", [SAILS], at(12, 1), at(12, 4));
    expect([...ledgerState([live, expired], now).claims]).toEqual([[OARS, "th-live"]]);
    expect(ledgerState([live, { v: 1, type: "release", at: at(12, 11), runId: "th-live" }], now).claims.size).toBe(0);
    expect(ledgerState([live, run("th-live", at(12, 11))], now).claims.size).toBe(0);
  });

  test("the latest audit of a file wins, and a void withdraws its cluster's audits", () => {
    const records: LedgerRecord[] = [cluster("th-1", 0, at(10), [OARS, SAILS]), cluster("th-2", 0, at(11), [OARS])];
    expect(ledgerState(records, now).audits.get(OARS)!.runId).toBe("th-2");
    const voided = ledgerState([...records, { v: 1, type: "void", at: at(12), runId: "th-2", cluster: 0, reason: "dropped" }], now);
    expect(voided.audits.get(OARS)!.runId).toBe("th-1");
    expect(voided.clusters.map(record => record.runId)).toEqual(["th-1"]);
  });

  test("a batch collects its clusters, its pull request, attempts and drops, then closes", () => {
    const records: LedgerRecord[] = [
      batch("opened", "ithaca-th-1", at(10), { package: "ithaca", branch: "test-health/ithaca-th-1", base: "origin/main", profile: "cron" }),
      cluster("th-1", 0, at(10, 1), [OARS], "ithaca-th-1", true),
      cluster("th-1", 1, at(10, 2), [SAILS], "ithaca-th-1", true),
      batch("pr", "ithaca-th-1", at(11), { pr: 4242 }),
      batch("attempt", "ithaca-th-1", at(11, 1)),
      batch("dropped", "ithaca-th-1", at(11, 2), { commit: "c".repeat(40) }),
      { v: 1, type: "void", at: at(11, 2), runId: "th-1", cluster: 1, reason: "failed in hosted proof" },
      batch("landed", "ithaca-th-1", at(11, 3), { mergeSha: "d".repeat(40) }),
    ];
    const state = ledgerState(records, now).batches.get("ithaca-th-1")!;
    expect({ status: state.status, pr: state.pr, attempts: state.attempts, dropped: state.dropped.length, closedAt: state.closedAt })
      .toEqual({ status: "landed", pr: 4242, attempts: 1, dropped: 1, closedAt: at(11, 3) });
    expect(state.clusters.map(entry => entry.files)).toEqual([[OARS]]);
  });

  test("audits of an abandoned batch never reached the base, so they do not count as audited", () => {
    const records: LedgerRecord[] = [
      batch("opened", "ithaca-th-1", at(10), { package: "ithaca", branch: "test-health/ithaca-th-1", base: "origin/main" }),
      cluster("th-1", 0, at(10, 1), [OARS], "ithaca-th-1", true),
      cluster("th-2", 0, at(10, 2), [SAILS]),
    ];
    expect([...landedOrPending(ledgerState(records, now)).keys()].sort()).toEqual([OARS, SAILS]);
    const abandoned = ledgerState([...records, batch("abandoned", "ithaca-th-1", at(11))], now);
    expect([...landedOrPending(abandoned).keys()]).toEqual([SAILS]);
  });
});

describe("a directory ledger", () => {
  test("appends by month, keeps earlier lines byte for byte and reads back in time order", () => {
    const dir = temp("ledger");
    const store = new DirLedgerStore(dir);
    const june = run("th-june", new Date(Date.UTC(2026, 5, 30)).toISOString());
    store.append([run("th-2", at(12)), june]);
    const before = readFileSync(join(dir, monthFile(at(12))), "utf8");
    store.append([run("th-3", at(13))], { "report.md": "# Test health\n" });
    expect(readFileSync(join(dir, monthFile(at(12))), "utf8").startsWith(before)).toBe(true);
    expect(store.read().map(record => record.runId)).toEqual(["th-june", "th-2", "th-3"]);
    expect(readFileSync(join(dir, "report.md"), "utf8")).toBe("# Test health\n");
  });

  test("stores a prepared patch one directory deep and reads it back; deeper names and records/ are refused", () => {
    const store = new DirLedgerStore(temp("ledger"));
    store.append([run("th-2", at(12))], { "wip/th-2-0.patch": "diff --git a/x b/x\n" });
    expect([store.readFile("wip/th-2-0.patch"), store.readFile("wip/th-9-0.patch")]).toEqual(["diff --git a/x b/x\n", null]);
    for (const name of ["wip/a/b.patch", "records/x.jsonl", "../x", "wip/.."]) expect(() => store.append([], { [name]: "x" })).toThrow("one directory deep");
  });
});

describe("the ledger on a shared ref", () => {
  /** A bare origin and two clones, as two agents on two machines would have. */
  function fixture() {
    const dir = temp("ledger-ref");
    const origin = join(dir, "origin.git"), seed = join(dir, "seed");
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    git(dir, "init", "-q", "-b", "main", seed);
    git(seed, "commit", "-q", "--allow-empty", "-m", "main");
    git(seed, "push", "-q", origin, "main");
    const clone = (name: string) => { const path = join(dir, name); git(dir, "clone", "-q", origin, path); return path; };
    return { origin, first: clone("first"), second: clone("second") };
  }

  test("the first append creates the ref, and nothing reaches a working tree or a local branch", () => {
    const { origin, first } = fixture();
    const store = new GitLedgerStore(first, "origin", REF);
    expect(store.read()).toEqual([]);
    store.append([run("th-1", at(12))]);
    expect(store.read().map(record => record.runId)).toEqual(["th-1"]);
    expect(git(origin, "ls-tree", "-r", "--name-only", REF)).toBe("records/2026-07.jsonl");
    expect(git(first, "status", "--porcelain")).toBe("");
    expect(git(first, "branch", "--list", "brain-test-health")).toBe("");
  });

  test("two writers that both read the same commit both land, each on top of the other", () => {
    const { origin, first, second } = fixture();
    const a = new GitLedgerStore(first, "origin", REF), b = new GitLedgerStore(second, "origin", REF);
    a.append([run("th-1", at(12, 1))]);
    // `b` has never fetched the ref; its append must still build on `a`'s commit.
    b.append([run("th-2", at(12, 2))], { "report.md": "# Test health\n" });
    a.append([run("th-3", at(12, 3))]);
    expect(b.read().map(record => record.runId)).toEqual(["th-1", "th-2", "th-3"]);
    expect(git(origin, "rev-list", "--count", REF)).toBe("3");
    expect(git(origin, "show", `${REF}:report.md`)).toBe("# Test health");
  });

  test("a prepared patch lands in wip/ next to the records, a second one keeps the first, and a clone reads them", () => {
    const { origin, first, second } = fixture();
    new GitLedgerStore(first, "origin", REF).append([run("th-1", at(12, 1))], { "wip/th-1-0.patch": "first\n" });
    new GitLedgerStore(second, "origin", REF).append([run("th-2", at(12, 2))], { "wip/th-2-0.patch": "second\n" });
    expect(git(origin, "ls-tree", "-r", "--name-only", REF).split("\n")).toEqual(["records/2026-07.jsonl", "wip/th-1-0.patch", "wip/th-2-0.patch"]);
    const reader = new GitLedgerStore(first, "origin", REF);
    expect([reader.readFile("wip/th-2-0.patch"), reader.readFile("wip/th-3-0.patch")]).toEqual(["second\n", null]);
    expect(() => reader.append([], { "records/x.jsonl": "x" })).toThrow("one directory deep");
  });

  test("a writer that loses the race to a concurrent push retries on the new commit instead of overwriting it", () => {
    const { origin, first, second } = fixture();
    const loser = new GitLedgerStore(first, "origin", REF);
    loser.append([run("th-1", at(12, 1))]);
    const winner = new GitLedgerStore(second, "origin", REF);
    // Interleave: the loser reads, the winner publishes, then the loser pushes with a stale lease.
    const racing = new GitLedgerStore(first, "origin", REF);
    const original = Bun.spawnSync;
    let pushes = 0;
    Bun.spawnSync = ((...args: Parameters<typeof Bun.spawnSync>) => {
      const command = args[0] as string[];
      if (Array.isArray(command) && command[1] === "push" && pushes++ === 0) winner.append([run("th-winner", at(12, 2))]);
      return original(...args);
    }) as typeof Bun.spawnSync;
    try { racing.append([run("th-loser", at(12, 3))]); } finally { Bun.spawnSync = original; }
    expect(pushes).toBe(3);
    expect(loser.read().map(record => record.runId)).toEqual(["th-1", "th-winner", "th-loser"]);
    expect(git(origin, "rev-list", "--count", REF)).toBe("3");
  });
});
