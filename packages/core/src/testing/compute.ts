/**
 * Published ComputeProvider contract suites — the executable form of the
 * promises in docs/extending/compute-providers.md and on the interface in
 * ../lib/seams.ts.
 *
 * `runComputeProviderContract` drives the provider directly:
 *
 *   1. capabilities are well-formed, and each optional method exists exactly
 *      when its capability says so
 *   2. `health` allocates nothing
 *   3. exit codes are reported as the command returned them
 *   4. a detached command runs until it is killed, and then reads `killed`
 *   5. a discard release removes the sandbox, and a second release is not an
 *      error
 *   6. an idempotent allocation key yields one sandbox
 *   7. a lost allocation response is reported `uncertain`, and `find`
 *      locates the sandbox it created
 *   8. staged source and collected artifacts honour declared paths and byte
 *      caps; a missing artifact reads `missing`
 *   9. a transport failure resolves `uncertain`; it never throws
 *  10. an already aborted call settles promptly
 *  11. the secret reaches neither the sandbox environment nor any outcome
 *  12. unknown cost is `null`, never zero
 *
 * `runComputeLifecycleContract` drives the same provider through core's job
 * lifecycle with disposable state: a job succeeds, keeps a nonzero exit,
 * cancels, records unknown cost as unknown, and leaves no secret in its
 * records.
 *
 * Providers run against caller-supplied fakes or disposable local resources,
 * never a vendor and never a real key.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ComputeCaller } from "../lib/compute/types.js";
import type {
  CommandHandle,
  CommandStatus,
  ComputeContext,
  ComputeProvider,
  SandboxRef,
  SourceBundle,
} from "../lib/seams.js";
import { settleWithin, type ContractTestPrimitives } from "./primitives.js";

export interface ComputeProviderContractHarness {
  name: string;
  /** A fresh provider. */
  provider(): ComputeProvider;
  /** What the suite puts in each context; the suite supplies the signal, deadline and logger. */
  context?(): { options?: unknown; secret?: string; fetch?: typeof fetch };
  /** argv for the provider's sandbox that does each thing. */
  commands: {
    /** Exit with this code. */
    exit(code: number): string[];
    /** Run for this many seconds. */
    sleep(seconds: number): string[];
    /** Write `text` to `path`, relative to the command's working directory, and exit 0. */
    write(path: string, text: string): string[];
    /** Print the environment as NAME=value lines and exit 0. */
    printEnv(): string[];
  };
  /** Sandboxes currently allocated and not released. */
  liveSandboxes(): number | Promise<number>;
  /** Perform the next call to `method`, then lose its response. */
  loseNextResponse?(method: "allocate"): void;
  /** Fail the next call to `method` in transport, with its effect unknown. */
  failNextTransport?(method: "allocate" | "poll"): void;
}

export interface ComputeLifecycleContractHarness extends ComputeProviderContractHarness {
  /** An empty, disposable directory outside any brain checkout. */
  stateDir(): string;
}

const SECRET = "odysseus-contract-secret-7f3a9c";
const POLL_MS = 20;
const SETTLE_MS = 15_000;
const ABORT_SETTLE_MS = 2_000;

function context(harness: ComputeProviderContractHarness, signal?: AbortSignal): ComputeContext {
  const extra = harness.context?.() ?? {};
  return {
    instanceId: "contract",
    options: extra.options ?? {},
    secret: extra.secret ?? SECRET,
    signal: signal ?? new AbortController().signal,
    deadline: Date.now() + 30_000,
    fetch: extra.fetch ?? globalThis.fetch,
    log: { debug() {}, warn() {} },
  };
}

function secretOf(harness: ComputeProviderContractHarness): string {
  return harness.context?.().secret ?? SECRET;
}

let keys = 0;
const freshKey = () => `contract-${process.pid}-${Date.now().toString(36)}-${(keys++).toString(36)}`;

async function allocate(provider: ComputeProvider, harness: ComputeProviderContractHarness, key = freshKey()): Promise<SandboxRef> {
  const outcome = await provider.allocate({ key, leaseSeconds: 300, retain: false }, context(harness));
  if (outcome.kind !== "ok") throw new Error(`allocate did not succeed: ${JSON.stringify(outcome)}`);
  return outcome.sandbox;
}

async function exec(provider: ComputeProvider, harness: ComputeProviderContractHarness, sandbox: SandboxRef, argv: string[], env: Record<string, string> = {}): Promise<CommandHandle> {
  const outcome = await provider.exec(sandbox, { argv, env }, context(harness));
  if (outcome.kind !== "ok") throw new Error(`exec did not succeed: ${JSON.stringify(outcome)}`);
  return outcome.handle;
}

async function waitExit(provider: ComputeProvider, harness: ComputeProviderContractHarness, handle: CommandHandle): Promise<Extract<CommandStatus, { kind: "exited" }>> {
  const until = Date.now() + SETTLE_MS;
  for (;;) {
    const status = await provider.poll(handle, context(harness));
    if (status.kind === "exited") return status;
    if (Date.now() > until) throw new Error(`command did not exit; last status ${JSON.stringify(status)}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function release(provider: ComputeProvider, harness: ComputeProviderContractHarness, sandbox: SandboxRef): Promise<void> {
  await provider.release(sandbox, "discard", context(harness));
}

function bundle(files: Record<string, string>): SourceBundle {
  const entries = Object.entries(files).map(([path, text]) => {
    const data = new TextEncoder().encode(text);
    return { path, sha256: new Bun.CryptoHasher("sha256").update(data).digest("hex"), bytes: data.byteLength, read: async () => data };
  });
  return { files: entries, hash: new Bun.CryptoHasher("sha256").update(JSON.stringify(entries.map((e) => [e.path, e.sha256]))).digest("hex") };
}

/** Register the provider contract suite for one harness. */
export function runComputeProviderContract(harness: ComputeProviderContractHarness, primitives: ContractTestPrimitives): void {
  const { describe, expect, test } = primitives;

  describe(`ComputeProvider contract: ${harness.name}`, () => {
    test("capabilities are well-formed", () => {
      const caps = harness.provider().capabilities;
      const limit = (v: unknown) => v === false || (typeof v === "object" && v !== null && Number.isInteger((v as { maxBytes?: unknown }).maxBytes) && (v as { maxBytes: number }).maxBytes > 0);
      expect({
        id: typeof harness.provider().id,
        commands: caps.commands,
        detached: typeof caps.detached,
        idempotentAllocate: typeof caps.idempotentAllocate,
        findByKey: typeof caps.findByKey,
        stage: limit(caps.stage),
        collect: limit(caps.collect),
        retain: caps.retain === false || (Number.isInteger(caps.retain?.maxSeconds) && caps.retain.maxSeconds > 0),
        maxLeaseSeconds: Number.isInteger(caps.maxLeaseSeconds) && caps.maxLeaseSeconds > 0,
        remoteExpiry: typeof caps.remoteExpiry,
        usage: caps.usage === "actual" || caps.usage === "none",
      }).toEqual({
        id: "string",
        commands: true,
        detached: "boolean",
        idempotentAllocate: "boolean",
        findByKey: "boolean",
        stage: true,
        collect: true,
        retain: true,
        maxLeaseSeconds: true,
        remoteExpiry: "boolean",
        usage: true,
      });
    });

    test("optional methods exist exactly when their capability says so", () => {
      const p = harness.provider();
      const caps = p.capabilities;
      expect({
        find: typeof p.find,
        stage: typeof p.stage,
        collect: typeof p.collect,
        usage: typeof p.usage,
      }).toEqual({
        find: caps.findByKey ? "function" : "undefined",
        stage: caps.stage ? "function" : "undefined",
        collect: caps.collect ? "function" : "undefined",
        usage: caps.usage === "actual" ? "function" : "undefined",
      });
    });

    test("health allocates nothing", async () => {
      const p = harness.provider();
      const before = await harness.liveSandboxes();
      const health = await p.health(context(harness));
      expect(health.kind === "ok" || health.kind === "unavailable").toBe(true);
      expect(await harness.liveSandboxes()).toBe(before);
    });

    test("exit codes are reported as the command returned them", async () => {
      const p = harness.provider();
      const sandbox = await allocate(p, harness);
      try {
        const zero = await waitExit(p, harness, await exec(p, harness, sandbox, harness.commands.exit(0)));
        const seven = await waitExit(p, harness, await exec(p, harness, sandbox, harness.commands.exit(7)));
        expect([zero.code, zero.reason, seven.code, seven.reason]).toEqual([0, "exited", 7, "exited"]);
      } finally {
        await release(p, harness, sandbox);
      }
    });

    test("a detached command runs until it is killed, then reads killed", async () => {
      const p = harness.provider();
      if (!p.capabilities.detached) return;
      const sandbox = await allocate(p, harness);
      try {
        const handle = await exec(p, harness, sandbox, harness.commands.sleep(30));
        expect((await p.poll(handle, context(harness))).kind).toBe("running");
        expect((await p.kill(handle, context(harness))).kind).toBe("ok");
        const status = await waitExit(p, harness, handle);
        expect(status.reason).toBe("killed");
      } finally {
        await release(p, harness, sandbox);
      }
    });

    test("a discard release removes the sandbox and a second release is not an error", async () => {
      const p = harness.provider();
      const before = await harness.liveSandboxes();
      const sandbox = await allocate(p, harness);
      expect(await harness.liveSandboxes()).toBe(before + 1);
      const first = await p.release(sandbox, "discard", context(harness));
      const second = await p.release(sandbox, "discard", context(harness));
      expect([first.kind, second.kind]).toEqual(["released", "released"]);
      expect(await harness.liveSandboxes()).toBe(before);
    });

    test("an idempotent allocation key yields one sandbox", async () => {
      const p = harness.provider();
      if (!p.capabilities.idempotentAllocate) return;
      const before = await harness.liveSandboxes();
      const key = freshKey();
      const a = await allocate(p, harness, key);
      const b = await allocate(p, harness, key);
      try {
        expect(b.id).toBe(a.id);
        expect(await harness.liveSandboxes()).toBe(before + 1);
      } finally {
        await release(p, harness, a);
      }
    });

    test("a lost allocation response is uncertain and find locates the sandbox", async () => {
      const p = harness.provider();
      if (!harness.loseNextResponse || !p.capabilities.findByKey) return;
      const before = await harness.liveSandboxes();
      const key = freshKey();
      harness.loseNextResponse("allocate");
      const lost = await p.allocate({ key, leaseSeconds: 300, retain: false }, context(harness));
      expect(lost.kind).toBe("uncertain");
      const found = await p.find!(key, context(harness));
      expect(found.kind).toBe("ok");
      if (found.kind === "ok") await release(p, harness, found.sandbox);
      expect(await harness.liveSandboxes()).toBe(before);
    });

    test("staging and collection honour declared paths and byte caps", async () => {
      const p = harness.provider();
      if (!p.stage || !p.collect || !p.capabilities.stage || !p.capabilities.collect) return;
      const sandbox = await allocate(p, harness);
      try {
        const staged = await p.stage(sandbox, bundle({ "notes/voyage.md": "# Ithaca\n" }), context(harness));
        expect(staged.kind).toBe("ok");
        await waitExit(p, harness, await exec(p, harness, sandbox, harness.commands.write("log.txt", "the suitors are counted")));
        const outcome = await p.collect(
          sandbox,
          { paths: [{ path: "log.txt", maxBytes: 1024 }, { path: "absent.txt", maxBytes: 1024 }, { path: "notes/voyage.md", maxBytes: 4 }] },
          context(harness)
        );
        expect(outcome.kind).toBe("ok");
        const byPath = Object.fromEntries((outcome.kind === "ok" ? outcome.artifacts : []).map((a) => [a.path, a]));
        const log = byPath["log.txt"];
        expect({
          log: log?.status === "collected" ? new TextDecoder().decode(log.data) : log?.status,
          absent: byPath["absent.txt"]?.status,
          voyage: byPath["notes/voyage.md"]?.status,
        }).toEqual({ log: "the suitors are counted", absent: "missing", voyage: "too_large" });
      } finally {
        await release(p, harness, sandbox);
      }
    });

    test("a transport failure resolves uncertain and never throws", async () => {
      const p = harness.provider();
      if (!harness.failNextTransport) return;
      const sandbox = await allocate(p, harness);
      try {
        const handle = await exec(p, harness, sandbox, harness.commands.exit(0));
        harness.failNextTransport("poll");
        const outcome = await settleWithin(p.poll(handle, context(harness)), SETTLE_MS);
        expect(outcome.state).toBe("resolved");
        expect(outcome.state === "resolved" ? outcome.value.kind : undefined).toBe("uncertain");
      } finally {
        await release(p, harness, sandbox);
      }
    });

    test("an already aborted call settles promptly", async () => {
      const p = harness.provider();
      const controller = new AbortController();
      controller.abort(new Error("contract abort"));
      const outcome = await settleWithin(p.allocate({ key: freshKey(), leaseSeconds: 300, retain: false }, context(harness, controller.signal)), ABORT_SETTLE_MS);
      expect(outcome.state === "pending").toBe(false);
      if (outcome.state === "resolved" && outcome.value.kind === "ok") await release(p, harness, outcome.value.sandbox);
    });

    test("the secret reaches neither the sandbox environment nor any outcome", async () => {
      const p = harness.provider();
      const secret = secretOf(harness);
      const sandbox = await allocate(p, harness);
      const seen: unknown[] = [sandbox];
      try {
        const handle = await exec(p, harness, sandbox, harness.commands.printEnv(), { VOYAGE: "ithaca" });
        seen.push(handle);
        const status = await waitExit(p, harness, handle);
        seen.push(status);
        expect((status.stdout ?? "").includes("VOYAGE=ithaca")).toBe(true);
      } finally {
        seen.push(await p.release(sandbox, "discard", context(harness)));
      }
      expect(JSON.stringify(seen).includes(secret)).toBe(false);
    });

    test("unknown cost is null, never zero", async () => {
      const p = harness.provider();
      if (!p.usage) return;
      const sandbox = await allocate(p, harness);
      await release(p, harness, sandbox);
      const cost = await p.usage(sandbox, context(harness));
      const consistent =
        (cost.usd === null && cost.coverage === "unknown") ||
        (typeof cost.usd === "number" && Number.isFinite(cost.usd) && cost.usd >= 0 && cost.coverage !== "unknown");
      expect(consistent).toBe(true);
    });
  });
}

const CALLER: ComputeCaller = { kind: "cli", principal: "penelope" };

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

/** Register the lifecycle contract suite: the provider driven through core's job lifecycle. */
export function runComputeLifecycleContract(harness: ComputeLifecycleContractHarness, primitives: ContractTestPrimitives): void {
  const { describe, expect, test } = primitives;

  // Loaded on use: the lifecycle's lock needs `bun:sqlite`, and this entry
  // must still load under Node for the suites that do not drive it.
  const service = async (root: string, stateDir: string) => {
    const { createComputeService } = await import("../lib/compute/service.js");
    const provider = harness.provider();
    const extra = harness.context?.() ?? {};
    return createComputeService({
      root,
      stateDir,
      env: { CONTRACT_COMPUTE_KEY: extra.secret ?? SECRET },
      fetch: extra.fetch,
      config: {
        compute: {
          providers: {
            contract: {
              provider,
              apiKeyEnv: "CONTRACT_COMPUTE_KEY",
              options: (extra.options as Record<string, unknown> | undefined) ?? undefined,
              lease: { maxSeconds: Math.min(600, provider.capabilities.maxLeaseSeconds) },
              maxConcurrent: 4,
            },
          },
        },
      },
    });
  };

  async function inBrain<T>(fn: (root: string, stateDir: string) => Promise<T>): Promise<T> {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "brain-compute-contract-")));
    mkdirSync(join(root, "notes"), { recursive: true });
    writeFileSync(join(root, "notes", "voyage.md"), "# Ithaca\n");
    try {
      return await fn(root, harness.stateDir());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function settle(svc: Awaited<ReturnType<typeof service>>, id: string) {
    const until = Date.now() + SETTLE_MS;
    for (;;) {
      const status = await svc.status(CALLER, id);
      if (!status.ok) throw new Error(`status refused: ${status.code}`);
      if (status.job.terminal && status.job.cleanup.state !== "release_failed") return status.job;
      if (Date.now() > until) throw new Error(`job did not settle: ${JSON.stringify(status.job)}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  describe(`ComputeProvider lifecycle contract: ${harness.name}`, () => {
    test("a job that exits 0 succeeds and releases its sandbox", async () => {
      await inBrain(async (root, stateDir) => {
        const svc = await service(root, stateDir);
        const before = await harness.liveSandboxes();
        const run = await svc.run(CALLER, { instance: "contract", argv: harness.commands.exit(0) });
        expect(run.ok).toBe(true);
        if (!run.ok) return;
        const job = await settle(svc, run.job.id);
        expect([job.state, job.exit?.code, job.cleanup.state]).toEqual(["succeeded", 0, "released"]);
        expect(await harness.liveSandboxes()).toBe(before);
      });
    });

    test("a nonzero exit fails the job and keeps its code", async () => {
      await inBrain(async (root, stateDir) => {
        const svc = await service(root, stateDir);
        const run = await svc.run(CALLER, { instance: "contract", argv: harness.commands.exit(7) });
        if (!run.ok) throw new Error(run.code);
        const job = await settle(svc, run.job.id);
        expect([job.state, job.exit?.code, job.exit?.reason, job.cleanup.state]).toEqual(["failed", 7, "exited", "released"]);
      });
    });

    test("cancelling a running job kills it and confirms release", async () => {
      const p = harness.provider();
      if (!p.capabilities.detached) return;
      await inBrain(async (root, stateDir) => {
        const svc = await service(root, stateDir);
        const before = await harness.liveSandboxes();
        const run = await svc.run(CALLER, { instance: "contract", argv: harness.commands.sleep(30) });
        if (!run.ok) throw new Error(run.code);
        expect(run.job.state).toBe("running");
        const cancelled = await svc.cancel(CALLER, run.job.id);
        expect(cancelled.ok && [cancelled.job.state, cancelled.job.cleanup.state]).toEqual(["cancelled", "released"]);
        expect(await harness.liveSandboxes()).toBe(before);
      });
    });

    test("unknown cost is recorded as unknown, never zero", async () => {
      await inBrain(async (root, stateDir) => {
        const svc = await service(root, stateDir);
        const run = await svc.run(CALLER, { instance: "contract", argv: harness.commands.exit(0) });
        if (!run.ok) throw new Error(run.code);
        const job = await settle(svc, run.job.id);
        const actual = job.cost.actual;
        expect(job.cost.estimate).toEqual({ usd: null, basis: "none" });
        expect(actual.usd === null ? actual.coverage : "known").toBe(actual.usd === null ? "unknown" : "known");
        if (harness.provider().capabilities.usage === "none") expect(actual).toEqual({ usd: null, coverage: "unknown", source: "none" });
      });
    });

    test("job records and outputs never hold the secret", async () => {
      await inBrain(async (root, stateDir) => {
        const svc = await service(root, stateDir);
        const secret = harness.context?.().secret ?? SECRET;
        const p = harness.provider();
        const run = await svc.run(CALLER, {
          instance: "contract",
          argv: harness.commands.printEnv(),
          env: { VOYAGE: "ithaca" },
          source: p.capabilities.stage ? ["notes/voyage.md"] : undefined,
        });
        if (!run.ok) throw new Error(run.code);
        await settle(svc, run.job.id);
        const leaked = filesUnder(stateDir).filter((file) => readFileSync(file).includes(secret));
        expect(leaked.map((file) => file.slice(dirname(stateDir).length))).toEqual([]);
      });
    });
  });
}
