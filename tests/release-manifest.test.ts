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

/** Strips a subpath import down to its package name (`@scope/name/sub` → `@scope/name`). */
function packageNameOf(specifier: string): string {
  return specifier.split("/").slice(0, 2).join("/");
}

const CI_YML = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

/** A `const <name> = [ ... ]` string list inside one of the smoke-test heredocs. */
/** The `run:` text of one pack-job step, read from the parsed workflow. */
function ciStep(name: string): string {
  const workflow = Bun.YAML.parse(CI_YML) as {
    jobs: { pack: { steps: { name?: string; run?: string }[] } };
  };
  const step = workflow.jobs.pack.steps.find((s) => s.name === name);
  if (!step?.run) throw new Error(`could not find the "${name}" step's run block in ci.yml`);
  return step.run;
}

/** The packages a step's `file:` overrides pin to a tarball. */
function overriddenIn(step: string): string[] {
  return [...step.matchAll(/"(@schlessera\/[^"]+)":\s*`file:/g)].map((m) => m[1]).sort();
}

function ciImportList(variable: string): string[] {
  const block = new RegExp(`const ${variable} = \\[([\\s\\S]*?)\\];`).exec(CI_YML);
  if (!block) throw new Error(`could not find \`const ${variable} = [...]\` in ci.yml`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
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
    const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("bun scripts/check-inbox-package.ts --root");
  });

  // The packed-install smoke test in CI asserts the bin's usage output. That
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

    const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    const smokeTest = workflow.slice(workflow.indexOf("CRON_USAGE="));
    expect(smokeTest).not.toBe("");
    for (const sub of subcommands) {
      expect(smokeTest.includes(sub)).toBe(true);
    }

    // The subcommand-name check above is too weak on its own, and it was: the
    // workflow greps the `run` line with `grep -qF`, in full, and
    // `--subprocess-env-extra` was added to that line by the 0.33.1 allowlist
    // without the workflow moving. Every name still appeared, so this test
    // stayed green while the pack job failed on the real string. Assert the
    // line the workflow actually matches.
    const runLine = usage.split("\n")[0]!;
    expect(runLine).toContain("brain-ui-cron run");
    expect(smokeTest).toContain(runLine);
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

  /** The pack step's shell up to and including the loop's `do` line. */
  function packLoopHeader(step: string): string | undefined {
    return /^([\s\S]*?\n\s*for package in\b[\s\S]*?\n\s*do\n)/.exec(step)?.[1];
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

  test("an added package directory reaches the CI pack loop with no list edit", () => {
    // Run the workflow's own step text up to the loop, with the loop body
    // swapped for an echo, so this exercises the shell that CI runs rather
    // than a description of it.
    const step = ciStep("Pack all workspaces");
    const header = packLoopHeader(step);
    if (!header) throw new Error("could not find the pack step's `for package in ... do` loop");
    withAddedPackage((root) => {
      mkdirSync(join(root, "scripts"));
      copyFileSync(join(ROOT, "scripts", "publishable-packages.ts"), join(root, "scripts", "publishable-packages.ts"));
      const runnerTemp = join(root, "runner-temp");
      mkdirSync(runnerTemp);
      const result = Bun.spawnSync(["bash", "-c", `${header}echo "PACK $package"\ndone\n`], {
        cwd: root,
        env: {
          PATH: `${resolve(process.execPath, "..")}:${process.env.PATH ?? ""}`,
          RUNNER_TEMP: runnerTemp,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const packed = lines(result).filter((l) => l.startsWith("PACK ")).map((l) => l.slice(5));
      expect(packed).toEqual(listPublishablePackages(root).map((p) => p.dir));
      expect(packed).toContain("a-module-ithaca");
    });
  });

  test("the CI pack loop stops when the list cannot be read", () => {
    // A failing command substitution inside a `for` list loops over nothing
    // and exits 0. The step must fail instead of packing zero packages.
    const step = ciStep("Pack all workspaces");
    const header = packLoopHeader(step);
    if (!header) throw new Error("could not find the pack step's `for package in ... do` loop");
    const root = mkdtempSync(join(tmpdir(), "publishable-pack-missing-"));
    try {
      const result = Bun.spawnSync(["bash", "-c", `${header}echo "PACK $package"\ndone\n`], {
        cwd: root,
        env: { PATH: `${resolve(process.execPath, "..")}:${process.env.PATH ?? ""}`, RUNNER_TEMP: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(new TextDecoder().decode(result.stdout)).not.toContain("PACK ");
      expect(result.exitCode).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(overriddenIn(ciStep("Install and smoke-test packed packages"))).toEqual(sortedNames);
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
    expect(overriddenIn(ciStep("Smoke-test brain-ui-react against React 18"))).toEqual([...needed].sort());
  });

  test("the CI bun smoke-test import list covers every publishable package", () => {
    expect(ciImportList("names").map(packageNameOf).sort()).toEqual(sortedNames);
  });

  test("the CI node smoke-test lists cover every publishable package, once", () => {
    // Every package must be probed under Node — either it imports cleanly
    // (nodePackages) or it fails only on its documented bun: dependency
    // (bunApiPackages). A package in neither list gets no check at all; a
    // package in both would hide a regression in one of the two expectations.
    const node = ciImportList("nodePackages").map(packageNameOf);
    const bunOnly = ciImportList("bunApiPackages").map(packageNameOf);
    const both = node.filter((n) => bunOnly.includes(n));
    expect(both).toEqual([]);
    expect([...new Set([...node, ...bunOnly])].sort()).toEqual(sortedNames);
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
