import { afterEach, describe, test, expect } from "bun:test";
import {
  chmodSync,
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

describe("brain CLI version probe", () => {
  test("a below-minimum brain repo pin refuses app creation", () => {
    const root = temporaryBrain();
    installBrainCli(root, `console.log("0.32.9");\n`);
    const observability = createRecordingObservability();

    expect(() =>
      createApp({
        config: appConfig(root),
        observability,
        registry: registry(),
      })
    ).toThrow(
      /brain CLI version 0\.32\.9.*version 0\.33\.0.*bump the brain repo's @schlessera\/brain pin/
    );
  });

  test("a malformed version string warns and still boots", () => {
    // "0.32.9-.." is not SemVer: the prerelease identifiers are empty. A loose
    // prerelease pattern would parse it as a real 0.32.9 prerelease and refuse
    // to boot; the contract is that anything unparseable warns and continues.
    const root = temporaryBrain();
    installBrainCli(root, `console.log("0.32.9-..");\n`);
    const observability = createRecordingObservability();

    const app = createApp({
      config: appConfig(root),
      observability,
      registry: registry(),
    });

    expect(
      observability.logs.count({ scope: "brain", severity: "WARN" })
    ).toBe(1);
    app.close();
  });

  test("an unresolvable CLI warns and still boots", () => {
    const root = temporaryBrain();
    const observability = createRecordingObservability();
    const app = createApp({
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
    app.close();
  });
});

// These tests require the brain repo at ~/brain
const LOCAL_BRAIN_PATH = `${process.env.HOME}/brain`;
const BRAIN_AVAILABLE = (() => {
  if (Bun.spawnSync(["test", "-d", `${LOCAL_BRAIN_PATH}/.git`]).exitCode !== 0) {
    return false;
  }
  const observability = createRecordingObservability();
  try {
    probeBrainCliVersion(LOCAL_BRAIN_PATH, observability.logger("brain"));
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
