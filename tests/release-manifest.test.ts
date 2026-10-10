/**
 * Repo-level release guards.
 *
 * These encode release pitfalls that have actually bitten, each of which was
 * documented in prose first and then walked into anyway. Prose does not fail a
 * build; these do.
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { pendingChangesetPackageErrors } from "../scripts/check-changeset-packages";
import { consumerManifest, CONSUMER_CHECKS, cronUsageProblems, PACK_TABLE, packPlan } from "../scripts/ci-pack";
import {
  listPublishablePackages,
  type PublishableManifest as Manifest,
} from "../scripts/publishable-packages";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");

import { ALLOWED_EDGES } from "./allowed-edges";
import {
  TEMPLATE_EXCLUDES,
  templateFilesToPublish,
} from "../scripts/publish-template";

const packages = listPublishablePackages(ROOT);
const names = new Set(packages.map((p) => p.manifest.name));
const dirs = packages.map((p) => p.dir).sort();
const sortedNames = [...names].sort();

const CI_YML = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

/** The packages a consumer manifest's `file:` overrides pin to a tarball. */
function overriddenIn(manifest: object): string[] {
  const overrides = (manifest as { overrides: Record<string, string> }).overrides;
  return Object.entries(overrides)
    .filter(([, target]) => target.startsWith("file:../brainkit-tarballs/"))
    .map(([name]) => name)
    .sort();
}

describe("release manifests", () => {
  test("every pending changeset names actual workspace packages", async () => {
    expect(await pendingChangesetPackageErrors(ROOT)).toEqual([]);
  });

  test("there are packages to check", () => {
    expect(packages.length).toBeGreaterThan(5);
  });

  // The template stayed pinned to the first release while every package moved
  // on, so a newly created brain installed an obsolete core.
  test("the template pins the current core version", () => {
    const core = packages.find((p) => p.manifest.name === "@schlessera/brain");
    if (!core) throw new Error("could not find the @schlessera/brain manifest");
    const template = JSON.parse(
      readFileSync(join(ROOT, "template/package.json"), "utf8")
    ) as Manifest;
    expect(template.dependencies?.["@schlessera/brain"]).toBe(`^${core.manifest.version}`);
  });

  // One package published MIT metadata without carrying the license text in
  // its package directory or tarball.
  test("every publishable package carries a LICENSE file", () => {
    const missing = packages
      .filter((p) => !existsSync(join(PACKAGES_DIR, p.dir, "LICENSE")))
      .map((p) => p.dir);
    expect(missing).toEqual([]);
  });

  test("ui-server ships the brain-ui-cron bun bin from dist", () => {
    const uiServer = packages.find(
      (p) => p.manifest.name === "@schlessera/brain-ui-server"
    );
    if (!uiServer) throw new Error("could not find the @schlessera/brain-ui-server manifest");
    const target = uiServer.manifest.bin?.["brain-ui-cron"];
    expect(target).toBe("./dist/bin/brain-ui-cron.js");
    expect(target?.replace(/^\.\/dist\//, "")).not.toBe(target);
    const source = readFileSync(
      join(PACKAGES_DIR, uiServer.dir, "src", "bin", "brain-ui-cron.ts"),
      "utf8"
    );
    expect(source.startsWith("#!/usr/bin/env bun\n")).toBe(true);
  });

  test("ui-server ships the operational recovery bin with a packed runtime check", () => {
    const uiServer = packages.find(p => p.manifest.name === "@schlessera/brain-ui-server")!;
    expect(uiServer.manifest.bin?.["brain-ui-inbox"]).toBe("./dist/bin/brain-ui-inbox.js");
    const source = readFileSync(join(PACKAGES_DIR, uiServer.dir, "src/bin/brain-ui-inbox.ts"), "utf8");
    expect(source.startsWith("#!/usr/bin/env bun\n")).toBe(true);
    expect(CONSUMER_CHECKS.map((check) => check.script)).toContain("check-inbox-package.ts");
  });

  // The pack job (scripts/ci-pack.ts) asserts the packed bin's usage output. That
  // assertion went stale the moment `crontab` and `environment` were added:
  // it still matched a two-subcommand line, so it failed the build instead of
  // proving anything. Both sides are decidable from files, so check them here
  // rather than waiting for CI to disagree with the source again.
  test("CI's packed-bin smoke test asserts every brain-ui-cron subcommand", () => {
    const uiServer = packages.find(
      (p) => p.manifest.name === "@schlessera/brain-ui-server"
    );
    if (!uiServer) throw new Error("could not find the @schlessera/brain-ui-server manifest");
    const source = readFileSync(
      join(PACKAGES_DIR, uiServer.dir, "src", "bin", "brain-ui-cron.ts"),
      "utf8"
    );
    const usage = /export const USAGE = `([^`]*)`/.exec(source)?.[1];
    if (!usage) throw new Error("could not read the USAGE template from brain-ui-cron.ts");
    const subcommands = [...usage.matchAll(/brain-ui-cron (\w+)/g)].map((m) => m[1]);
    expect(subcommands.length).toBeGreaterThan(1);

    expect(cronUsageProblems(2, usage)).toEqual([]);
    expect(cronUsageProblems(0, usage)).not.toEqual([]);
    // Every usage line is asserted: dropping any one of them fails the probe.
    const lines = usage.split("\n");
    for (const [index, line] of lines.entries()) {
      const without = lines.filter((_, other) => other !== index).join("\n");
      expect(cronUsageProblems(2, without), line).not.toEqual([]);
    }

    // A name-only check is too weak on its own, and it was: the probe matches
    // the `run` line in full, and `--subprocess-env-extra` was added to that
    // line by the 0.33.1 allowlist without the probe moving. Every name still
    // appeared, so a name check stayed green while the pack job failed on the
    // real string. The run line must be asserted verbatim.
    const runLine = lines[0]!;
    expect(runLine).toContain("brain-ui-cron run");
    expect(cronUsageProblems(2, usage.replace(runLine, runLine.replace(" [--subprocess-env-extra <names>]", "")))).not.toEqual([]);
  });

  // The command a developer types INSIDE a package must not flake either: bun's
  // default per-test timeout is 5s, and the CLI-spawning suites tip over it on
  // machine load alone — an intermittent single failure that passes on its own
  // every time. The root script carries `--timeout 30000` (and CI runs that
  // script rather than a copy of its command); every per-package script must
  // carry it too, or a new package ships a `bun run test` that lies.
  test("every test script carries the 30s timeout, and CI runs the root script", () => {
    const offenders = packages
      .filter((p) => !p.manifest.scripts?.test?.includes("--timeout 30000"))
      .map((p) => p.manifest.name);
    expect(offenders).toEqual([]);
    const root = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Manifest;
    expect(root.scripts?.test).toContain("--timeout 30000");
    // CI's concurrent runner must still delegate to the root script so its
    // timeout and offline preload apply to the selected files.
    expect(CI_YML).toContain("run: bun scripts/ci-runner.ts");
    const runner = readFileSync(join(ROOT, "scripts/ci-runner.ts"), "utf8");
    expect(runner).toContain('"run", "test"');
  });

  // Changesets majors any package that peer-depends on something being
  // released once the new version falls outside the declared range. With a
  // fixed group that promotion spreads to every package, so one caret range
  // turns a minor release into 1.0.0. `*` is never out of range.
  test("internal peer dependencies are ranged `*`", () => {
    const offenders: string[] = [];
    for (const { manifest } of packages) {
      for (const [dep, range] of Object.entries(manifest.peerDependencies ?? {})) {
        if (!names.has(dep)) continue; // external peers are not our problem
        if (range !== "*") offenders.push(`${manifest.name} → ${dep}@${range}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the changesets fixed group covers every publishable package", () => {
    const config = JSON.parse(readFileSync(join(ROOT, ".changeset/config.json"), "utf8")) as {
      fixed?: string[][];
      ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH?: Record<string, unknown>;
    };
    const group = new Set(config.fixed?.[0] ?? []);
    const missing = [...names].filter((n) => !group.has(n));
    expect(missing).toEqual([]);
  });

  test("the peer-dependent guard stays enabled", () => {
    const config = JSON.parse(readFileSync(join(ROOT, ".changeset/config.json"), "utf8")) as {
      ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH?: {
        onlyUpdatePeerDependentsWhenOutOfRange?: boolean;
      };
    };
    expect(
      config.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH
        ?.onlyUpdatePeerDependentsWhenOutOfRange
    ).toBe(true);
  });

  test("all packages sit on one version", () => {
    // The fixed group guarantees this after a release; a drift here means a
    // hand-edited manifest and a release that will not do what it appears to.
    expect(new Set(packages.map((p) => p.manifest.version)).size).toBe(1);
  });
});

// build, publish, clean and the CI pack job used to carry four hand-maintained
// copies of the package list, kept aligned by regex-parsing each one. A package
// missing from one is silently skipped, and the release ships dependents pinned
// to a version nobody published (the 0.2.0 failure in a new guise). They now
// all read scripts/publishable-packages.ts, so these tests prove two things:
// the function finds and orders packages, and every consumer really uses it.
describe("the publishable package list", () => {
  function writeManifest(root: string, dir: string, manifest: Record<string, unknown>): void {
    mkdirSync(join(root, "packages", dir), { recursive: true });
    writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify(manifest));
  }

  /**
   * A copy of this workspace's manifests plus one package nobody listed
   * anywhere: an Ithaca module that depends on core, in a directory whose name
   * sorts before core's dependencies.
   */
  function withAddedPackage(run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "publishable-packages-"));
    try {
      for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
        const manifest = join(PACKAGES_DIR, entry.name, "package.json");
        if (!entry.isDirectory() || !existsSync(manifest)) continue;
        mkdirSync(join(root, "packages", entry.name), { recursive: true });
        copyFileSync(manifest, join(root, "packages", entry.name, "package.json"));
      }
      writeManifest(root, "a-module-ithaca", {
        name: "@schlessera/brain-module-ithaca",
        version: packages[0]!.version,
        dependencies: { "@schlessera/brain": "workspace:*" },
      });
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function lines(result: { exitCode: number; stdout: Uint8Array; stderr: Uint8Array }): string[] {
    const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode, stderr).toBe(0);
    return new TextDecoder().decode(result.stdout).split("\n").filter(Boolean);
  }

  test("the workspace list is every non-private manifest, in dependency order", () => {
    const fromDisk = readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(PACKAGES_DIR, e.name, "package.json")))
      .filter((e) => !JSON.parse(readFileSync(join(PACKAGES_DIR, e.name, "package.json"), "utf8")).private)
      .map((e) => e.name)
      .sort();
    expect(fromDisk.length).toBeGreaterThan(5);
    expect(dirs).toEqual(fromDisk);
  });

  // The order is what keeps a dependent from going out before its dependency.
  // Asserted against the ALLOWED_EDGES table (tests/allowed-edges.ts) — a
  // superset of the actual manifest edges, which dependency-edges.test.ts pins
  // — over hard dependencies only: internal peers are ranged `*`, so no
  // publish order can break them.
  test("the workspace list puts every package after its internal hard dependencies", () => {
    const position = new Map(packages.map((p, index) => [p.name, index]));
    const violations: string[] = [];
    let checked = 0;
    for (const [name, edges] of Object.entries(ALLOWED_EDGES)) {
      for (const dep of edges.dependencies) {
        const nameAt = position.get(name);
        const depAt = position.get(dep);
        if (nameAt === undefined || depAt === undefined) continue;
        checked += 1;
        if (depAt > nameAt) violations.push(`${name} is listed before its dependency ${dep}`);
      }
    }
    expect(checked).toBeGreaterThan(5);
    expect(violations).toEqual([]);
  });

  test("orders by hard dependencies, skips private and manifest-less directories, ignores peer and dev edges", () => {
    const root = mkdtempSync(join(tmpdir(), "publishable-order-"));
    try {
      // Alphabetical order would put the app first; its dependency must win.
      writeManifest(root, "app", {
        name: "@fixture/app", version: "1.0.0",
        dependencies: { "@fixture/lib": "workspace:*" },
        optionalDependencies: { "@fixture/opt": "workspace:*" },
      });
      writeManifest(root, "lib", {
        name: "@fixture/lib", version: "1.0.0",
        // A dev or peer edge back to the app is not a publish-order constraint.
        devDependencies: { "@fixture/app": "workspace:*" },
        peerDependencies: { "@fixture/app": "*" },
      });
      writeManifest(root, "opt", { name: "@fixture/opt", version: "1.0.0" });
      writeManifest(root, "internal", { name: "@fixture/internal", version: "1.0.0", private: true });
      mkdirSync(join(root, "packages", "notes"));
      expect(listPublishablePackages(root).map((p) => p.dir)).toEqual(["lib", "opt", "app"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a hard dependency cycle instead of guessing an order", () => {
    const root = mkdtempSync(join(tmpdir(), "publishable-cycle-"));
    try {
      writeManifest(root, "a", { name: "@fixture/a", version: "1.0.0", dependencies: { "@fixture/b": "*" } });
      writeManifest(root, "b", { name: "@fixture/b", version: "1.0.0", dependencies: { "@fixture/a": "*" } });
      expect(() => listPublishablePackages(root)).toThrow("form a cycle among @fixture/a, @fixture/b");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an added package directory reaches the build, the release and the CLI with no list edit", () => {
    withAddedPackage((root) => {
      const expected = listPublishablePackages(root).map((p) => p.dir);
      expect(expected).toContain("a-module-ithaca");
      expect(expected.length).toBe(packages.length + 1);
      expect(expected.indexOf("a-module-ithaca")).toBeGreaterThan(expected.indexOf("core"));

      const run = (script: string, ...args: string[]) =>
        Bun.spawnSync([process.execPath, join(ROOT, "scripts", script), ...args], {
          cwd: ROOT, stdout: "pipe", stderr: "pipe",
        });
      expect(lines(run("publishable-packages.ts", root))).toEqual(expected);
      expect(lines(run("build.ts", "--dry-run", root))).toEqual(
        expected.map((dir) => `Would build packages/${dir}`)
      );
      const byDir = new Map(listPublishablePackages(root).map((p) => [p.dir, p]));
      expect(lines(run("publish.ts", "--dry-run", root))).toEqual(
        expected.map((dir) => `Would publish ${byDir.get(dir)!.name}@${byDir.get(dir)!.version} (packages/${dir})`)
      );
    });
  });

  test("an added package directory reaches the CI pack plan, which refuses it until it has a row", () => {
    // The pack job reads the same list. A package nobody described would ship
    // with no tarball, import or Node expectation, so the plan names it and
    // stops; given a row, it is packed after the packages it depends on.
    withAddedPackage((root) => {
      expect(() => packPlan(root)).toThrow("packages/a-module-ithaca has no row in the pack table");
      const row = { files: ["dist/index.js"], bun: ["@schlessera/brain-module-ithaca"], node: "bun-only" as const };
      const planned = packPlan(root, { ...PACK_TABLE, "a-module-ithaca": row }).map((e) => e.pkg.dir);
      expect(planned).toEqual(listPublishablePackages(root).map((p) => p.dir));
      expect(planned.indexOf("a-module-ithaca")).toBeGreaterThan(planned.indexOf("core"));
    });
  });

  test("the CI pack plan stops when the list cannot be read", () => {
    // Packing zero packages must fail, not pass.
    const root = mkdtempSync(join(tmpdir(), "publishable-pack-missing-"));
    try {
      expect(() => packPlan(root)).toThrow();
      mkdirSync(join(root, "packages"));
      expect(() => packPlan(root)).toThrow("No publishable packages found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the CI pack job runs the table-driven script after the build", () => {
    const workflow = Bun.YAML.parse(CI_YML) as {
      jobs: { pack: { steps: { run?: string }[] } };
    };
    const commands = workflow.jobs.pack.steps.map((step) => step.run ?? "");
    const build = commands.indexOf("bun run build");
    expect(build).toBeGreaterThan(commands.indexOf("bun install --frozen-lockfile"));
    expect(commands.slice(build + 1)).toEqual(["bun scripts/ci-pack.ts"]);
  });
});

describe("pending changeset package gate", () => {
  function withFixture(run: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "changeset-packages-"));
    try {
      mkdirSync(join(root, "packages", "engine"), { recursive: true });
      mkdirSync(join(root, ".changeset"));
      writeFileSync(join(root, "package.json"), JSON.stringify({
        name: "fixture-workspace", private: true, workspaces: ["packages/*"],
      }));
      writeFileSync(join(root, "packages", "engine", "package.json"), JSON.stringify({
        name: "@fixture/actual-engine", version: "0.1.0",
      }));
      run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  function gate(root: string) {
    const result = Bun.spawnSync(["bun", join(ROOT, "scripts/check-changeset-packages.ts"), root]);
    return { code: result.exitCode, stderr: new TextDecoder().decode(result.stderr) };
  }

  test("accepts actual manifest names and empty changesets through the executable", () => {
    withFixture(root => {
      writeFileSync(join(root, ".changeset", "valid.md"), "---\n'@fixture/actual-engine': minor\n---\n\nA release.\n");
      writeFileSync(join(root, ".changeset", "empty.md"), "---\n{}\n---\n\nDocumentation.\n");
      expect(gate(root)).toEqual({ code: 0, stderr: "" });
    });
  });

  test("rejects all unknown names with file diagnostics through the executable", () => {
    withFixture(root => {
      writeFileSync(join(root, ".changeset", "bad.md"), "---\n'@fixture/actual-engine': minor\n'@fixture/missing-one': minor\n'@fixture/missing-two': patch\n---\n\nA release.\n");
      const result = gate(root);
      expect(result.stderr).toContain('.changeset/bad.md: unknown workspace package "@fixture/missing-one"');
      expect(result.stderr).toContain('.changeset/bad.md: unknown workspace package "@fixture/missing-two"');
      expect(result.code).toBe(1);
    });
  });

  test("parser failures cannot report a passing gate", () => {
    withFixture(root => {
      writeFileSync(join(root, ".changeset", "broken.md"), "---\n'@fixture/actual-engine': [\n---\n\nInvalid YAML.\n");
      const result = gate(root);
      expect(result.stderr).toContain("Cannot validate pending changeset packages:");
      expect(result.code).toBe(1);
    });
  });

  test("CI validates the full pending set after a frozen install", () => {
    const workflow = Bun.YAML.parse(CI_YML) as {
      jobs: { changeset: { steps: { run?: string }[] } };
    };
    const commands = workflow.jobs.changeset.steps.map(step => step.run ?? "");
    const install = commands.indexOf("bun install --frozen-lockfile");
    const validate = commands.indexOf("bun scripts/check-changeset-packages.ts");
    expect(install).toBeGreaterThanOrEqual(0);
    expect(validate).toBeGreaterThan(install);
    expect(commands.slice(validate + 1).join("\n")).toContain("bun scripts/check-changeset.ts");
  });
});

// G1: every hand-maintained enumeration of the workspace is asserted against
// the packages/* glob. The CI pack job shipped for months with a 10-package
// list while 12 packages published — module-images and render-template got no
// pack check and no consumer-import smoke test, and nothing could notice,
// because the guard above only reads scripts/*.ts and the docs are prose.
describe("workspace enumerations", () => {
  test("the CI smoke-test overrides pin a tarball for every publishable package", () => {
    // The overrides map is how the consumer install resolves workspace deps to
    // the packed tarballs. A package absent here resolves from the public
    // registry instead, and the smoke test silently tests the PREVIOUS release.
    expect(overriddenIn(consumerManifest("smoke", packPlan(ROOT)))).toEqual(sortedNames);
  });

  test("the React 18 smoke test pins every internal package brain-ui-react needs to its tarball", () => {
    // brain-ui-react and the internal packages it depends on, found from the
    // manifests rather than listed here, so a new internal dependency that the
    // step forgets resolves from npm and fails this test instead.
    const react = packages.find((p) => p.manifest.name === "@schlessera/brain-ui-react")!;
    // Bun installs peers and optional dependencies by default, so an internal
    // one resolves from npm unless it is pinned too.
    const internal = (name: string) => {
      const manifest = packages.find((p) => p.manifest.name === name)?.manifest;
      return Object.keys({
        ...manifest?.dependencies,
        ...manifest?.peerDependencies,
        ...manifest?.optionalDependencies,
      }).filter((dep) => dep.startsWith("@schlessera/"));
    };
    const needed = new Set([react.manifest.name]);
    for (const name of needed) for (const dep of internal(name)) needed.add(dep);
    expect(needed.size).toBeGreaterThan(1);
    const react18 = packPlan(ROOT).filter((e) => e.row.react18);
    expect(overriddenIn(consumerManifest("react18", react18))).toEqual([...needed].sort());
  });

  test("the pack table has one valid row per publishable package", () => {
    // Every package is imported under Bun and has a Node expectation — it
    // imports cleanly, or it is bun-only and fails only on its documented bun:
    // dependency. packPlan refuses a package with no row, a stale row, or a
    // specifier filed under the wrong package.
    expect(packPlan(ROOT).map((e) => e.pkg.dir)).toEqual(packages.map((p) => p.dir));
  });

  test("the README repository layout block enumerates exactly the publishable packages", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const block = /## Repository layout\s*\n+```\n([\s\S]*?)```/.exec(readme);
    if (!block) throw new Error("could not find the Repository layout code block in README.md");
    const rows = [...block[1].matchAll(/^packages\/([a-z-]+)\s+(@schlessera\/[a-z-]+)/gm)];
    expect(rows.map((m) => m[1]).sort()).toEqual(dirs);
    expect(rows.map((m) => m[2]).sort()).toEqual(sortedNames);
  });

  test("the ROADMAP package table enumerates exactly the publishable packages", () => {
    const roadmap = readFileSync(join(ROOT, "ROADMAP.md"), "utf8");
    const section = /## Where this stands\n([\s\S]*?)\n## /.exec(roadmap);
    if (!section) throw new Error("could not find the 'Where this stands' section in ROADMAP.md");
    // First-column code spans of the table. Grouped rows abbreviate siblings
    // (`brain-module-jobs` / `-speaking` / `-finance`); a span starting with a
    // hyphen continues the previous span's prefix.
    const listed: string[] = [];
    for (const line of section[1].split("\n")) {
      if (!/^\|\s*`/.test(line)) continue;
      const firstCell = line.split("|")[1] ?? "";
      for (const span of firstCell.matchAll(/`([^`]+)`/g)) {
        const token = span[1];
        const previous = listed[listed.length - 1];
        const expanded =
          token.startsWith("-") && previous
            ? previous.slice(0, previous.lastIndexOf("-")) + token
            : token;
        listed.push(expanded);
      }
    }
    expect(listed.map((n) => `@schlessera/${n.replace(/^@schlessera\//, "")}`).sort()).toEqual(
      sortedNames
    );
  });

  test("every prose package count agrees with the packages/* glob", () => {
    // "Ten packages ship in lockstep" survived two package additions because
    // no machine ever read the word "Ten".
    // Every document that states how many packages ship. ROADMAP said "Ten"
    // through two package additions; the release skill and CONTRIBUTING said
    // "eleven" through one, and the skill is the file an agent loads BEFORE
    // cutting a release — the worst possible place for a stale number.
    const sources = [
      "ROADMAP.md",
      "CONTRIBUTING.md",
      ".agents/skills/release/SKILL.md",
    ];
    const prose = sources.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
    const words: Record<string, number> = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
      eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
      fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
      nineteen: 19, twenty: 20,
    };
    // "N packages ship", "N packages move", "all N packages" — and the bare
    // "lands on all N at once" / "spread it to all N", where the noun is
    // implied. The release skill carried two of those, one stale for two
    // package additions, precisely because the word "packages" was missing.
    const counts = [
      ...prose.matchAll(/\b(?:all\s+)?([A-Za-z]+|\d+)\s+packages\b/g),
      ...prose.matchAll(/\ball\s+([A-Za-z]+|\d+)\b(?!\s+packages\b)/g),
    ]
      .map((m) => (/^\d+$/.test(m[1]) ? Number(m[1]) : words[m[1].toLowerCase()]))
      .filter((n): n is number => n !== undefined);
    expect(counts.length).toBeGreaterThan(2);
    for (const count of counts) expect(count).toBe(packages.length);
  });
});

// A fresh `bun install` (which `bun run version` forces) resolves each
// dependent's ranges independently: with our pi pins at 0.80.6 while
// pi-coding-agent ranged `^0.80.6`, the resolver nested a NEWER pi-ai copy
// under pi-coding-agent whose exports no longer matched, and the pi backend
// failed at import time — in this workspace and for any npm consumer. Caught
// during the 0.17.0 release. The guard: our exact pins on the pi family must
// agree with each other, so a single hoisted copy satisfies every dependent.
describe("pi dependency pins are coherent", () => {
  test("ui-backend-pi pins one version for the whole @earendil-works family", async () => {
    const manifest = (await Bun.file(
      new URL("../packages/ui-backend-pi/package.json", import.meta.url).pathname
    ).json()) as { dependencies: Record<string, string> };
    const pins = Object.entries(manifest.dependencies).filter(([name]) =>
      name.startsWith("@earendil-works/")
    );
    expect(pins.length).toBeGreaterThanOrEqual(3);
    const versions = new Set(pins.map(([, v]) => v));
    expect([...versions]).toHaveLength(1);
    for (const [, version] of pins) {
      // Exact pins only: a range here re-opens the nested-copy hazard.
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

// The published template repository is generated from `template/`, and three
// documents send a new user straight at it. Two things can go wrong silently:
// a development-only file ships, or the release stops publishing the template
// at all and the repository drifts back to whatever it held last.
describe("the published template", () => {
  test("ships exactly this file list", async () => {
    // A golden, not a filter: adding anything to `template/` fails here until
    // someone decides whether a user should get it or whether it belongs in
    // TEMPLATE_EXCLUDES. That decision is the point — a "development-only file
    // does not ship" rule enforced by a filter only catches the files somebody
    // already thought of.
    expect(await templateFilesToPublish()).toEqual([
      ".agents/skills/.gitkeep",
      ".asset-cache.jsonl",
      ".claude/settings.json",
      ".context-cache.jsonl",
      ".env.example",
      ".gitattributes",
      ".gitignore",
      ".mcp.json",
      "CLAUDE.md",
      "README.md",
      "brain.config.ts",
      "context/.gitkeep",
      "evals/.gitkeep",
      "me/.gitkeep",
      "notes/hello-brain.md",
      "package.json",
    ]);
  });

  test("excludes the maintainer note, and that file is really there", () => {
    expect(TEMPLATE_EXCLUDES).toContain("README-template-dev.md");
    // An exclusion for a file that no longer exists is an exclusion nobody is
    // maintaining.
    for (const excluded of TEMPLATE_EXCLUDES) {
      expect(existsSync(join(ROOT, "template", excluded))).toBe(true);
    }
  });

  test("the sidecar caches ship empty, which is the contract brain index expects", () => {
    for (const sidecar of [".context-cache.jsonl", ".asset-cache.jsonl"]) {
      expect(readFileSync(join(ROOT, "template", sidecar), "utf8")).toBe("");
    }
  });

  test("the release publishes it, rather than a runbook asking someone to", () => {
    // `bun run release` is the only thing that knows which version went out.
    const publish = readFileSync(join(ROOT, "scripts/publish.ts"), "utf8");
    expect(publish).toContain("publishTemplate");
  });

  test("the release skill names the step", () => {
    const skill = readFileSync(join(ROOT, ".agents/skills/release/SKILL.md"), "utf8");
    expect(skill).toContain("publish-template.ts");
  });
});
