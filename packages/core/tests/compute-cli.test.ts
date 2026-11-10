/**
 * `brain compute` CLI contract (#3107): every `--json` envelope, the refusal
 * codes and their exit status, an attached run, `--detach`, cancellation by
 * signal and the caller binding. Spawns the real bin keyless against a temp
 * brain whose config passes offline providers by value; no vendor, no key.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BRAIN_BIN, keylessEnv, runCli } from "./cli-harness";
import { computeBrain, FAULT_CONFIG, type ComputeBrain } from "./helpers/compute/cli-brain";

let box: ComputeBrain;
let bare: ComputeBrain;
let faults: ComputeBrain;

beforeAll(() => {
  box = computeBrain();
  bare = computeBrain(null);
  faults = computeBrain(FAULT_CONFIG);
});
afterAll(() => {
  box?.dispose();
  bare?.dispose();
  faults?.dispose();
});

const cli = (b: ComputeBrain, args: string[], env: Record<string, string> = {}) => runCli(b.root, ["compute", ...args], { ...b.env, ...env });
const json = (stdout: string) => JSON.parse(stdout) as Record<string, any>;
const jobIds = (b: ComputeBrain) => (existsSync(join(b.state, "jobs")) ? readdirSync(join(b.state, "jobs")) : []);
const liveSandboxes = (b: ComputeBrain) => readdirSync(b.work).filter((d) => !existsSync(join(b.work, d, ".retain-until"))).length;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function expectJobShape(job: Record<string, any>): void {
  expect(Object.keys(job).sort()).toEqual(
    ["artifacts", "blocked", "cancelRequested", "cleanup", "cost", "createdAt", "exit", "id", "instance", "lease", "provider", "settled", "source", "state", "terminal", "uncertain", "updatedAt"].sort()
  );
  expect(job.id).toMatch(/^cj_[a-z2-7]{26}$/);
  expect(job.createdAt).toMatch(ISO);
  expect(job.lease.deadline).toMatch(ISO);
  expect(Object.keys(job.cost).sort()).toEqual(["actual", "estimate"]);
  expect(Object.keys(job.cleanup).sort()).toEqual(["lastError", "retainedUntil", "state"]);
}

describe("health", () => {
  test("reports every instance without allocating, and is enabled: false without config", async () => {
    const r = await cli(box, ["health", "--json"]);
    expect(r.code).toBe(0);
    const out = json(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.enabled).toBe(true);
    const byId = Object.fromEntries(out.instances.map((i: any) => [i.id, i]));
    expect(Object.keys(byId)).toEqual(["argos-unknown", "ithaca-host", "ithaca-long", "pylos-memory", "sparta-keyed"]);
    expect(byId["ithaca-host"]).toMatchObject({ provider: "local-process", status: "ready", reason: null });
    expect(byId["ithaca-host"].capabilities.maxLeaseSeconds).toBe(86400);
    expect(byId["argos-unknown"]).toMatchObject({ provider: null, status: "provider_unknown", capabilities: null });
    expect(byId["sparta-keyed"].status).toBe("provider_unavailable");
    expect(byId["sparta-keyed"].reason).toContain("ODYSSEUS_SPARTA_COMPUTE_KEY");
    expect(liveSandboxes(box)).toBe(0);

    const off = await cli(bare, ["health", "--json"]);
    expect(off.code).toBe(0);
    expect(json(off.stdout)).toEqual({ ok: true, enabled: false, instances: [] });
  });
});

describe("refusals: machine-readable, exit 1, nothing allocated", () => {
  const cases: [string, () => ComputeBrain, string[], string][] = [
    ["compute_disabled", () => bare, ["run", "--provider", "ithaca-host", "--json", "--", "true"], "compute_disabled"],
    ["provider_unknown (no such instance)", () => box, ["run", "--provider", "calypso", "--json", "--", "true"], "provider_unknown"],
    ["provider_unknown (no such implementation)", () => box, ["run", "--provider", "argos-unknown", "--json", "--", "true"], "provider_unknown"],
    ["provider_unavailable (credential unset)", () => box, ["run", "--provider", "sparta-keyed", "--json", "--", "exit", "0"], "provider_unavailable"],
    ["capability_unsupported (lease above the provider's ceiling)", () => box, ["run", "--provider", "ithaca-long", "--lease", "100000", "--json", "--", "true"], "capability_unsupported"],
    ["capability_unsupported (retention)", () => box, ["plan", "--provider", "pylos-memory", "--retain", "--json", "--", "exit", "0"], "capability_unsupported"],
    ["policy_denied (credential-shaped variable)", () => box, ["run", "--provider", "ithaca-host", "--env", "ITHACA_TOKEN=x", "--json", "--", "true"], "policy_denied"],
    ["source_refused (undeclared path)", () => box, ["plan", "--provider", "ithaca-host", "--source", "notes/missing.md", "--json", "--", "true"], "source_refused"],
  ];
  for (const [name, which, args, code] of cases) {
    test(name, async () => {
      const b = which();
      const before = jobIds(b).length;
      const r = await cli(b, args);
      expect(r.code).toBe(1);
      const out = json(r.stdout);
      expect(out.ok).toBe(false);
      expect(Object.keys(out).sort()).toEqual(["error", "ok"]);
      expect(out.error.code).toBe(code);
      expect(typeof out.error.message).toBe("string");
      expect(jobIds(b).length).toBe(before);
      expect(liveSandboxes(b)).toBe(0);
    });
  }

  test("a disabled brain gets no state directory at all", async () => {
    const r = await cli(bare, ["plan", "--provider", "ithaca-host", "--json", "--", "true"]);
    expect(json(r.stdout).error.code).toBe("compute_disabled");
    expect(readdirSync(bare.state)).toEqual([]);
  });

  test("human mode names the code on stderr", async () => {
    const r = await cli(box, ["run", "--provider", "calypso", "--human", "--", "true"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("compute refused (provider_unknown)");
  });
});

describe("usage errors", () => {
  for (const [args, message] of [
    [["run", "--", "true"], "--provider is required"],
    [["run", "--provider", "ithaca-host"], "needs a command after --"],
    [["run", "--provider", "ithaca-host", "--caller", "penelope", "--", "true"], "Unknown flag: --caller"],
    [["status"], "Usage: brain compute status JOB"],
    [["abandon", "cj_aaaaaaaaaaaaaaaaaaaaaaaaaa"], "--confirm"],
    [["run", "--provider", "ithaca-host", "--lease", "1.5", "--", "true"], "--lease must be a positive whole number"],
    [["status", "x", "--provider", "ithaca-host"], "Unsupported compute status flag: --provider"],
  ] as [string[], string][]) {
    test(args.join(" "), async () => {
      const r = await cli(box, args);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(message);
      expect(r.stdout).toBe("");
    });
  }
});

describe("plan", () => {
  test("returns the lease, the exact source manifest and an unknown estimate as null", async () => {
    // Other cases may have left jobs in the shared brain: a plan adds none.
    const jobsBefore = jobIds(box);
    const r = await cli(box, ["plan", "--provider", "ithaca-host", "--source", "notes/route.md", "--source", "notes/raft.md", "--artifact", "out/chart.txt:2048", "--lease", "60", "--json", "--", "true"]);
    expect(r.code).toBe(0);
    const { ok, plan } = json(r.stdout);
    expect(ok).toBe(true);
    expect(plan).toMatchObject({
      instance: "ithaca-host",
      provider: "local-process",
      lease: { seconds: 60, releaseAllowanceSeconds: 300 },
      artifacts: [{ path: "out/chart.txt", maxBytes: 2048 }],
      estimate: { usd: null, basis: "none" },
      retain: false,
      slots: { max: 4 },
    });
    expect(plan.source.files.map((f: any) => f.path)).toEqual(["notes/raft.md", "notes/route.md"]);
    expect(plan.source.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(jobIds(box)).toEqual(jobsBefore);
  });
});

describe("run", () => {
  test("attached: drives the job to its end and prints the final status", async () => {
    const r = await cli(box, ["run", "--provider", "ithaca-host", "--source", "notes/raft.md", "--artifact", "out.txt", "--env", "VOYAGE=ithaca", "--json", "--", "sh", "-c", 'cat notes/raft.md; printf "%s" "$VOYAGE" > out.txt']);
    expect(r.code).toBe(0);
    const { ok, job } = json(r.stdout);
    expect(ok).toBe(true);
    expectJobShape(job);
    expect(job).toMatchObject({ instance: "ithaca-host", provider: "local-process", state: "succeeded", exit: { code: 0, reason: "exited" }, blocked: null });
    expect(job.cleanup.state).toBe("released");
    expect(job.cost.actual).toEqual({ usd: null, coverage: "unknown", source: "none" });
    expect(job.source.files).toBe(1);
    expect(job.artifacts).toEqual([{ path: "out.txt", status: "collected", bytes: 6, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(r.stdout.trim().split("\n")[0]).toBe("{");

    const collected = await cli(box, ["collect", job.id, "--json"]);
    expect(collected.code).toBe(0);
    const c = json(collected.stdout);
    expect(Object.keys(c).sort()).toEqual(["artifacts", "job", "ok", "output"]);
    expect(c.output).toEqual({ stdout: "---\ntype: note\n---\n# The raft\nTwenty trees, felled on Ogygia.\n", stderr: "", truncated: false });
    expect(c.artifacts[0].file).toStartWith(box.state);
    expect(readFileSync(c.artifacts[0].file, "utf8")).toBe("ithaca");
  });

  test("attached: a nonzero exit ends failed with exit 3 and the code kept", async () => {
    const r = await cli(box, ["run", "--provider", "ithaca-host", "--json", "--", "sh", "-c", "exit 7"]);
    expect(r.code).toBe(3);
    const { job } = json(r.stdout);
    expect(job.state).toBe("failed");
    expect(job.exit).toMatchObject({ code: 7, reason: "exited" });
    expect(job.cleanup.state).toBe("released");
  });

  test("human mode prints an unknown cost as unknown, never as zero", async () => {
    const r = await cli(box, ["run", "--provider", "ithaca-host", "--human", "--", "true"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("cost: unknown (unknown); no estimate");
    expect(r.stdout).not.toMatch(/\$0\.0000/);
  });

  test("--detach returns once started; status, cancel and collect address the job", async () => {
    const r = await cli(box, ["run", "--provider", "ithaca-host", "--detach", "--json", "--", "sleep", "60"]);
    expect(r.code).toBe(0);
    const { job } = json(r.stdout);
    expect(job.state).toBe("running");
    expect(job.terminal).toBeNull();
    expect(liveSandboxes(box)).toBe(1);

    const status = json((await cli(box, ["status", job.id, "--json"])).stdout);
    expect(status).toMatchObject({ ok: true, job: { id: job.id, state: "running", exit: null } });

    const cancelled = await cli(box, ["cancel", job.id, "--json"]);
    expect(cancelled.code).toBe(0);
    const c = json(cancelled.stdout);
    expect(c.job).toMatchObject({ state: "cancelled", cancelRequested: true, cleanup: { state: "released" } });
    expect(liveSandboxes(box)).toBe(0);

    const collected = json((await cli(box, ["collect", job.id, "--json"])).stdout);
    expect(collected.job.state).toBe("cancelled");
  });

  test("SIGTERM during an attached run cancels the job and reports the release", async () => {
    const proc = Bun.spawn(["bun", BRAIN_BIN, "compute", "run", "--provider", "ithaca-host", "--json", "--", "sleep", "60"], {
      env: { ...keylessEnv(box.root), ...box.env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const before = new Set(jobIds(box));
    const deadline = Date.now() + 20_000;
    let id: string | undefined;
    while (Date.now() < deadline) {
      id = jobIds(box).find((j) => !before.has(j));
      if (id && existsSync(join(box.state, "jobs", id, "job.json")) && JSON.parse(readFileSync(join(box.state, "jobs", id, "job.json"), "utf8")).state === "running") break;
      await Bun.sleep(50);
    }
    expect(id).toBeDefined();
    proc.kill("SIGTERM");
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toContain("SIGTERM received, cancelling");
    expect(code).toBe(3);
    const { job } = json(stdout);
    expect(job).toMatchObject({ id, state: "cancelled", cancelRequested: true, cleanup: { state: "released" } });
    expect(liveSandboxes(box)).toBe(0);
  }, 30_000);
});

describe("a run interrupted or left unclean", () => {
  const gate = () => join(faults.work, "open-stage");
  const spawnRun = (args: string[]) =>
    Bun.spawn(["bun", BRAIN_BIN, "compute", "run", ...args], {
      env: { ...keylessEnv(faults.root), ...faults.env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

  /** Wait until a new job of `faults` is recorded in `state`. */
  async function newJobIn(before: Set<string>, state: string): Promise<string> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const id = jobIds(faults).find((j) => !before.has(j));
      if (id && existsSync(join(faults.state, "jobs", id, "job.json")) && JSON.parse(readFileSync(join(faults.state, "jobs", id, "job.json"), "utf8")).state === state) return id;
      await Bun.sleep(50);
    }
    throw new Error(`no new job reached ${state}`);
  }

  /**
   * Read `reader` until the text seen so far contains `needle`, the stream
   * ends or 10 s pass (a failure maximum, cleared once a read answers); return
   * everything read. The run logs a signal from its handler, so that line is
   * on stderr once the signal has been recorded.
   */
  async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, seen = ""): Promise<string> {
    const decoder = new TextDecoder();
    const deadline = Date.now() + 10_000;
    while (!seen.includes(needle) && Date.now() < deadline) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<undefined>((resolve) => (timer = setTimeout(resolve, deadline - Date.now(), undefined)));
      const chunk = await Promise.race([reader.read(), late]);
      clearTimeout(timer);
      if (!chunk || chunk.done) break;
      seen += decoder.decode(chunk.value, { stream: true });
    }
    return seen;
  }

  /** The rest of `reader`'s stream, after `seen`. */
  async function readToEnd(reader: ReadableStreamDefaultReader<Uint8Array>, seen: string): Promise<string> {
    const decoder = new TextDecoder();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) seen += decoder.decode(chunk.value, { stream: true });
    return seen + decoder.decode();
  }

  test("a signal while the job is still starting is kept: the job is cancelled once it has started", async () => {
    rmSync(gate(), { force: true });
    const before = new Set(jobIds(faults));
    // A leaky-provider case may already have left its sandboxes: this run adds none.
    const sandboxesBefore = liveSandboxes(faults);
    const proc = spawnRun(["--provider", "ithaca-gated", "--source", "notes/raft.md", "--json", "--", "sleep", "60"]);
    const id = await newJobIn(before, "staging");
    proc.kill("SIGTERM");
    // Open the stage only once the run has recorded the signal, so it arrives while the job is starting.
    const reader = proc.stderr.getReader();
    const logged = await readUntil(reader, "SIGTERM received");
    expect(logged).toContain("SIGTERM received");
    writeFileSync(gate(), "");
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), readToEnd(reader, logged), proc.exited]);
    rmSync(gate(), { force: true });
    expect(code).toBe(3);
    expect(stderr).toContain("SIGTERM received, cancelling");
    const { job } = json(stdout);
    expect(job).toMatchObject({ id, state: "cancelled", cancelRequested: true, cleanup: { state: "released" } });
    expect(liveSandboxes(faults)).toBe(sandboxesBefore);
  }, 30_000);

  test("human mode names the job on stderr as soon as it is recorded, before it has started", async () => {
    rmSync(gate(), { force: true });
    const before = new Set(jobIds(faults));
    const sandboxesBefore = liveSandboxes(faults);
    const proc = spawnRun(["--provider", "ithaca-gated", "--source", "notes/route.md", "--human", "--", "sleep", "60"]);
    const id = await newJobIn(before, "staging");
    const reader = proc.stderr.getReader();
    const seen = await readUntil(reader, id);
    expect(seen).toContain(id);
    proc.kill("SIGINT");
    // Open the stage only once the run has recorded the signal, so it arrives while the job is starting.
    expect(await readUntil(reader, "SIGINT received", seen)).toContain("SIGINT received");
    writeFileSync(gate(), "");
    reader.releaseLock();
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    rmSync(gate(), { force: true });
    expect(code).toBe(3);
    expect(stdout).toContain(`job ${id}: cancelled`);
    expect(liveSandboxes(faults)).toBe(sandboxesBefore);
  }, 30_000);

  test("an attached run whose release is never confirmed exits 2 and points at reconcile", async () => {
    const r = await cli(faults, ["run", "--provider", "ithaca-leaky", "--json", "--", "true"]);
    const { job } = json(r.stdout);
    expect(job).toMatchObject({ state: "succeeded", cleanup: { state: "release_failed" } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("brain compute reconcile");
  }, 30_000);
});

describe("human output", () => {
  test("escapes terminal control sequences from the provider and the remote command; JSON keeps the bytes", async () => {
    const r = await cli(faults, ["run", "--provider", "ithaca-leaky", "--human", "--", "sh", "-c", "printf '\\033]0;Circe\\007\\033[2Jhome\\tport\\n'"]);
    expect(r.code).toBe(2);
    const id = /job (cj_[a-z2-7]{26})/.exec(r.stdout)?.[1];
    expect(id).toBeDefined();
    expect(r.stdout).toContain("the harbour \\x1b]0;Scylla\\x07is closed \\x1b[2J");
    const collected = await cli(faults, ["collect", id!, "--human"]);
    expect(collected.stdout).toContain("\\x1b]0;Circe\\x07\\x1b[2Jhome\tport\n");
    for (const out of [r.stdout, r.stderr, collected.stdout, collected.stderr]) expect(out).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    const raw = json((await cli(faults, ["collect", id!, "--json"])).stdout);
    expect(raw.output.stdout).toBe("\u001b]0;Circe\u0007\u001b[2Jhome\tport\n");
    expect(raw.job.cleanup.lastError).toContain("\u001b]0;Scylla\u0007");
  }, 30_000);
});

describe("caller binding", () => {
  test("an unknown or foreign job id is job_unknown, exit 1", async () => {
    for (const verb of ["status", "cancel", "collect"]) {
      const r = await cli(box, [verb, "cj_aaaaaaaaaaaaaaaaaaaaaaaaaa", "--json"]);
      expect(r.code).toBe(1);
      expect(json(r.stdout).error.code).toBe("job_unknown");
    }
  });

  test("reconcile visits nothing held and reports the jobs it settled", async () => {
    const r = await cli(box, ["reconcile", "--json"]);
    expect(r.code).toBe(0);
    const out = json(r.stdout);
    expect(out.ok).toBe(true);
    expect(Array.isArray(out.visited)).toBe(true);
    expect(Array.isArray(out.skipped)).toBe(true);
  });

  test("abandon refuses a job that is not uncertain", async () => {
    const run = json((await cli(box, ["run", "--provider", "ithaca-host", "--json", "--", "true"])).stdout);
    const r = await cli(box, ["abandon", run.job.id, "--confirm", "--json"]);
    expect(r.code).toBe(1);
    expect(json(r.stdout).error.code).toBe("policy_denied");
  });
});
