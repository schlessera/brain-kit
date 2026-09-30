import { afterEach, describe, test, expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createApp } from "../src/app";
import { createBrainClient, probeBrainCliVersion } from "../src/brain/client";
import { resolveServerConfig } from "../src/config/env";
import { createRecordingObservability } from "../src/observability/index";
import { makeFakeBackend } from "./helpers/fake-backend";
import { createBrainRoutes } from "../src/routes/brain";

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length) {
    rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
  }
});

function temporaryBrain(): string {
  const root = mkdtempSync(join(tmpdir(), "brain-client-test-"));
  temporaryRoots.push(root);
  return root;
}

function installBrainCli(root: string, source: string): void {
  const binDir = join(root, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const bin = join(binDir, "brain");
  writeFileSync(bin, `#!/usr/bin/env bun\n${source}`);
  chmodSync(bin, 0o755);
}

function appConfig(brainPath: string) {
  return resolveServerConfig({
    AUTH_MODE: "none",
    HOST: "127.0.0.1",
    DB_PATH: ":memory:",
    BRAIN_PATH: brainPath,
    BRAIN_UI_PRICING_DISCOVERY: "0",
  });
}

const registry = () =>
  createStaticBackendRegistry([makeFakeBackend({ id: "fake" })]);

describe("brain CLI invocation", () => {
  test("a stats embeddings count the CLI could not take reaches the HTTP body as null, not 0", async () => {
    // `brain stats --json` reports `embeddings: null` when the brain has a
    // vector table this host cannot count (#169). The client and route pass
    // the object through; neither may coerce the unknown into a number.
    const root = temporaryBrain();
    installBrainCli(
      root,
      `console.log(JSON.stringify({ documents: 3, byType: { note: 3 }, byStatus: { active: 3 }, ` +
        `byRelevance: {}, tags: 0, links: 0, brokenLinks: 0, chunks: 3, embeddings: null, ` +
        `health: { embeddingCoverage: null } }));\n`
    );
    const brain = createBrainClient({ brainPath: root });

    const stats = (await brain.stats()) as unknown as Record<string, unknown>;
    expect(stats.embeddings).toBeNull();

    const app = createBrainRoutes({ brain, brainPath: root, keyterms: { brainPath: root, cacheDir: root, limit: 10 } });
    const response = await app.request("/brain/stats");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("embeddings", null);

    // And a count that was taken passes through as the number it is.
    installBrainCli(root, `console.log(JSON.stringify({ documents: 3, chunks: 3, embeddings: 7 }));\n`);
    expect(((await brain.stats()) as unknown as Record<string, unknown>).embeddings).toBe(7);
    expect(await (await app.request("/brain/stats")).json()).toHaveProperty("embeddings", 7);
  });

  test("stats history runs `brain stats --history` and the route passes its nulls through", async () => {
    const root = temporaryBrain();
    const capture = join(root, "argv.jsonl");
    installBrainCli(
      root,
      `import { appendFileSync } from "fs";\n` +
        `appendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
        `console.log(JSON.stringify({ dates: ["2026-09-01", "2026-09-02"], documents: [3, 4], ` +
        `health: { orphans: [null, 1] } }));\n`
    );
    const brain = createBrainClient({ brainPath: root });
    const app = createBrainRoutes({ brain, brainPath: root, keyterms: { brainPath: root, cacheDir: root, limit: 10 } });

    const response = await app.request("/brain/stats/history");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      dates: ["2026-09-01", "2026-09-02"],
      documents: [3, 4],
      health: { orphans: [null, 1] },
    });
    expect(JSON.parse(readFileSync(capture, "utf8").trim())).toEqual(["stats", "--history"]);

    // A CLI that predates --history exits 1: the route says so as a 500.
    installBrainCli(root, `console.error("Unknown flag: --history"); process.exit(1);\n`);
    const old = await app.request("/brain/stats/history");
    expect(old.status).toBe(500);
    expect(((await old.json()) as { error: string }).error).toContain("Unknown flag: --history");
  });

  test("places flags before -- and a --prefixed search query after it", async () => {
    const root = temporaryBrain();
    const capture = join(root, "argv.jsonl");
    installBrainCli(
      root,
      `import { appendFileSync } from "fs";\n` +
        `appendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n` +
        `console.log(JSON.stringify({ results: [], warnings: [] }));\n`
    );

    await createBrainClient({ brainPath: root }).search("--weird query", {
      type: "note",
      limit: 2,
    });

    expect(JSON.parse(readFileSync(capture, "utf8").trim())).toEqual([
      "search",
      "--type",
      "note",
      "--limit",
      "2",
      "--",
      "--weird query",
    ]);
  });
});

describe("search cancellation and deadlines", () => {
  async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for subprocess state");
      await Bun.sleep(10);
    }
  }

  /**
   * The pid the stalled CLI wrote, or null until it has written one:
   * `writeFileSync` creates the file before it writes, and `Number("")` is 0,
   * which `kill(0, 0)` reports running for as long as this test lives.
   */
  function pidIn(path: string): number | null {
    const text = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    return /^[1-9]\d*$/.test(text) ? Number(text) : null;
  }

  function running(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  function stalledBrain() {
    const root = temporaryBrain();
    const pidPath = join(root, "search.pid");
    installBrainCli(root, `
      import { writeFileSync } from "fs";
      process.on("SIGTERM", () => {});
      writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      setInterval(() => {}, 1000);
    `);
    return { root, pidPath };
  }

  test("an already cancelled search never starts the CLI", async () => {
    const { root, pidPath } = stalledBrain();
    await expect(createBrainClient({ brainPath: root }).search("query", {
      signal: AbortSignal.abort(),
    })).rejects.toHaveProperty("name", "AbortError");
    expect(existsSync(pidPath)).toBe(false);
  });

  test("aborting a running search reaps a CLI that ignores SIGTERM", async () => {
    const { root, pidPath } = stalledBrain();
    const controller = new AbortController();
    const result = createBrainClient({ brainPath: root }).search("query", { signal: controller.signal })
      .then(() => null, (error: Error) => error);
    try {
      await waitUntil(() => pidIn(pidPath) !== null);
      const pid = pidIn(pidPath)!;
      controller.abort();
      expect(await result).toHaveProperty("name", "AbortError");
      expect(running(pid)).toBe(false);
    } finally {
      controller.abort();
      await result;
    }
  });

  test("HTTP search deadlines return 504 and reap the stalled process", async () => {
    const { root, pidPath } = stalledBrain();
    const brain = createBrainClient({ brainPath: root, searchTimeoutMs: 1_500 });
    const app = createBrainRoutes({ brain, brainPath: root, keyterms: { brainPath: root, cacheDir: root, limit: 10 } });
    const response = await app.request("/brain/search?q=query");
    expect(response.status).toBe(504);
    expect(await response.json()).toHaveProperty("error", expect.stringContaining("timed out"));
    const pid = pidIn(pidPath);
    expect(pid).not.toBeNull();
    expect(running(pid!)).toBe(false);
  });

  test("a real HTTP disconnect propagates through Hono to the search process", async () => {
    const { root, pidPath } = stalledBrain();
    const brain = createBrainClient({ brainPath: root });
    const app = createBrainRoutes({ brain, brainPath: root, keyterms: { brainPath: root, cacheDir: root, limit: 10 } });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const controller = new AbortController();
    const response = fetch(`http://127.0.0.1:${server.port}/brain/search?q=query`, { signal: controller.signal })
      .catch((error: Error) => error);
    try {
      await waitUntil(() => pidIn(pidPath) !== null);
      const pid = pidIn(pidPath)!;
      controller.abort();
      await response;
      await waitUntil(() => !running(pid));
    } finally {
      controller.abort();
      await response;
      await server.stop(true);
    }
  });
});

describe("brain CLI version probe", () => {
  test("a below-minimum brain repo pin refuses app creation", async () => {
    const root = temporaryBrain();
    installBrainCli(root, `console.log("0.32.9");\n`);
    const observability = createRecordingObservability();

    await expect(createApp({
        config: appConfig(root),
        observability,
        registry: registry(),
      })).rejects.toThrow(/brain CLI version 0\.32\.9.*version 0\.33\.0.*bump the brain repo's @schlessera\/brain pin/);
  });

  test("a malformed version string warns and still boots", async () => {
    // "0.32.9-.." is not SemVer: the prerelease identifiers are empty. A loose
    // prerelease pattern would parse it as a real 0.32.9 prerelease and refuse
    // to boot; the contract is that anything unparseable warns and continues.
    const root = temporaryBrain();
    installBrainCli(root, `console.log("0.32.9-..");\n`);
    const observability = createRecordingObservability();

    const app = await createApp({
      config: appConfig(root),
      observability,
      registry: registry(),
    });

    expect(
      observability.logs.count({ scope: "brain", severity: "WARN" })
    ).toBe(1);
    await app.close();
  });

  test("an unresolvable CLI warns and still boots", async () => {
    const root = temporaryBrain();
    const observability = createRecordingObservability();
    const app = await createApp({
      config: appConfig(root),
      observability,
      registry: registry(),
    });

    expect(
      observability.logs.count({
        scope: "brain",
        severity: "WARN",
        body: "version probe failed",
      })
    ).toBe(1);
    await app.close();
  });
});

// These tests require the brain repo at ~/brain
const LOCAL_BRAIN_PATH = `${process.env.HOME}/brain`;
const BRAIN_AVAILABLE = await (async () => {
  if (Bun.spawnSync(["test", "-d", `${LOCAL_BRAIN_PATH}/.git`]).exitCode !== 0) {
    return false;
  }
  const observability = createRecordingObservability();
  try {
    await probeBrainCliVersion(LOCAL_BRAIN_PATH, observability.logger("brain"));
    return observability.logs.count({ severity: "WARN" }) === 0;
  } catch {
    return false;
  }
})();

const client = createBrainClient({ brainPath: LOCAL_BRAIN_PATH });
const brainSearch = client.search;
const brainBriefing = client.briefing;
const brainStats = client.stats;
const brainList = client.list;
const brainRead = client.read;
const brainValidate = client.validate;

describe.skipIf(!BRAIN_AVAILABLE)("brain CLI client", () => {
  describe("brainSearch", () => {
    test("returns results for a known query", async () => {
      const { results, warnings } = await brainSearch("identity");
      expect(results).toBeArray();
      expect(results.length).toBeGreaterThan(0);
      expect(warnings).toBeArray();
    });

    test("results have expected shape", async () => {
      const { results } = await brainSearch("identity", { limit: 1 });
      const result = results[0];
      expect(result).toHaveProperty("path");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("type");
      expect(result).toHaveProperty("score");
    });

    test("respects limit option", async () => {
      const { results } = await brainSearch("identity", { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    test("respects type filter", async () => {
      const { results } = await brainSearch("identity", {
        type: "identity",
        limit: 5,
      });
      for (const r of results) {
        expect(r.type).toBe("identity");
      }
    });

    test("returns empty array for nonsense query", async () => {
      const { results } = await brainSearch("xyzzyplughfoo123nonsense");
      expect(results).toBeArray();
      // Might still return fuzzy results, but should be empty or very few
    });
  });

  describe("brainStats", () => {
    test("returns document count", async () => {
      const stats = await brainStats();
      expect(stats.documents).toBeGreaterThan(0);
    });

    test("returns type breakdown", async () => {
      const stats = await brainStats();
      expect(stats.byType).toBeDefined();
      expect(typeof stats.byType).toBe("object");
      expect(Object.keys(stats.byType).length).toBeGreaterThan(0);
    });

    test("returns status breakdown", async () => {
      const stats = await brainStats();
      expect(stats.byStatus).toBeDefined();
    });

    test("includes expected types", async () => {
      const stats = await brainStats();
      expect(stats.byType.identity).toBeGreaterThan(0);
      expect(stats.byType.talk).toBeGreaterThan(0);
    });
  });

  describe("brainBriefing", () => {
    test("returns non-empty string", async () => {
      const content = await brainBriefing();
      expect(typeof content).toBe("string");
      expect(content.length).toBeGreaterThan(0);
    });
  });

  describe("brainList", () => {
    test("returns documents", async () => {
      const results = await brainList({ limit: 3 });
      expect(results).toBeArray();
      expect(results.length).toBeGreaterThan(0);
    });

    test("documents have expected fields", async () => {
      const results = await brainList({ limit: 1 });
      const doc = results[0];
      expect(doc).toHaveProperty("path");
      expect(doc).toHaveProperty("title");
      expect(doc).toHaveProperty("type");
    });

    test("filters by type", async () => {
      const results = await brainList({ type: "identity", limit: 5 });
      for (const doc of results) {
        expect(doc.type).toBe("identity");
      }
    });

    test("respects limit", async () => {
      const results = await brainList({ limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe("brainRead", () => {
    test("reads a known document", async () => {
      const content = await brainRead("me/identity.md");
      expect(typeof content).toBe("string");
      expect(content.length).toBeGreaterThan(0);
    });

    test("throws for nonexistent path", async () => {
      await expect(brainRead("nonexistent/file.md")).rejects.toThrow();
    });
  });

  describe("brainValidate", () => {
    test("returns validation output", async () => {
      const output = await brainValidate();
      expect(typeof output).toBe("string");
    });
  });
});

/**
 * Every brain CLI launch goes through the host's exec wrapper, not only the
 * agent's tool spawns. The CLI imports the repository's `brain.config.ts` and
 * its repo-resolved modules — agent-writable executable inputs — so a search
 * executes repository code exactly as a tool call does. An independent review
 * of the first version of this seam found these two spawns still launching
 * directly, which left the privilege boundary with a hole the size of the
 * whole read path.
 */
describe("the exec wrapper covers the shared CLI client", () => {
  let previous: string | undefined;

  afterEach(() => {
    if (previous === undefined) delete process.env.BRAIN_UI_EXEC_WRAPPER;
    else process.env.BRAIN_UI_EXEC_WRAPPER = previous;
  });

  function installWrapper(root: string): string {
    const log = join(root, "wrapper-argv.log");
    const wrapper = join(root, "wrapper.sh");
    writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${log}'\nexec "$@"\n`, {
      mode: 0o755,
    });
    chmodSync(wrapper, 0o755);
    return log;
  }

  test("a search runs through the wrapper, with the CLI as its argument", async () => {
    const root = temporaryBrain();
    installBrainCli(root, `console.log(JSON.stringify({ results: [], warnings: [] }));\n`);
    const log = installWrapper(root);
    previous = process.env.BRAIN_UI_EXEC_WRAPPER;
    process.env.BRAIN_UI_EXEC_WRAPPER = join(root, "wrapper.sh");

    await createBrainClient({ brainPath: root }).search("anything", {
      signal: AbortSignal.timeout(20_000),
    });

    const argv = readFileSync(log, "utf-8").split("\n").filter(Boolean);
    // argv[0] of the recorded line is the program the wrapper was asked to
    // run — the brain CLI — and "search" is among the arguments it kept.
    expect(argv[0]).toContain("brain");
    expect(argv).toContain("search");
  }, 30_000);

  test("with no wrapper configured the CLI is launched directly", async () => {
    const root = temporaryBrain();
    installBrainCli(root, `console.log(JSON.stringify({ results: [], warnings: [] }));\n`);
    const log = installWrapper(root);
    previous = process.env.BRAIN_UI_EXEC_WRAPPER;
    delete process.env.BRAIN_UI_EXEC_WRAPPER;

    await createBrainClient({ brainPath: root }).search("anything", {
      signal: AbortSignal.timeout(20_000),
    });

    expect(existsSync(log)).toBe(false);
  }, 30_000);

  test("a probe that times out does not orphan the CLI behind its wrapper", async () => {
    // spawnSync's timeout kills the process it started, which with a
    // supervising wrapper is the wrapper — the CLI it launched keeps running.
    const root = temporaryBrain();
    const childPidFile = join(root, "child.pid");
    installBrainCli(root, `console.log("0.36.0");\n`);

    const wrapper = join(root, "supervise.sh");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nsleep 300 &\necho $! > '${childPidFile}'\nsleep 300\n`,
      { mode: 0o755 }
    );
    chmodSync(wrapper, 0o755);
    previous = process.env.BRAIN_UI_EXEC_WRAPPER;
    process.env.BRAIN_UI_EXEC_WRAPPER = wrapper;

    // Times out after 5s, logs a warning, and continues — the probe is
    // advisory. What must not survive it is the child.
    await probeBrainCliVersion(root, createRecordingObservability().logger("test"));

    const childPid = Number(readFileSync(childPidFile, "utf-8").trim());
    const deadline = Date.now() + 10_000;
    const alive = () => {
      try {
        process.kill(childPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    while (alive() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(alive()).toBe(false);
  }, 60_000);

  test("the version probe goes through it too, so a broken wrapper fails at boot", async () => {
    const root = temporaryBrain();
    installBrainCli(root, `console.log("0.36.0");\n`);
    const log = installWrapper(root);
    previous = process.env.BRAIN_UI_EXEC_WRAPPER;
    process.env.BRAIN_UI_EXEC_WRAPPER = join(root, "wrapper.sh");

    await probeBrainCliVersion(root, createRecordingObservability().logger("test"));

    expect(readFileSync(log, "utf-8")).toContain("--version");
  }, 30_000);
});
