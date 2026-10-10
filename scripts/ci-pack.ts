/**
 * CI's pack job: pack every publishable package, install the tarballs into
 * clean consumers, and probe what a consumer actually gets.
 *
 *   bun run build && bun scripts/ci-pack.ts
 *
 * The workflow runs exactly this after its build step, and `bun run check:pack`
 * runs the workflow's pack job locally, so both run the same probes. Working
 * directories go under `$RUNNER_TEMP` when it is set (CI, check:pack) and a
 * removed temporary directory otherwise.
 *
 * The package list is `scripts/publishable-packages.ts`; what each package is
 * probed for is one row of PACK_TABLE below. A publishable package without a
 * row, or a row without a package, fails before anything is packed: a package
 * nobody described would otherwise ship with no consumer probe at all.
 *
 * Phases, in order:
 * 1. Workspace pins match the packed manifests (`check-publish-pins.ts`).
 *    Before the consumer, whose `file:` overrides would mask a wrong pin.
 * 2. Pack each package and assert its tarball entries.
 * 3. Install every tarball into one consumer. Under Bun and under Node, one
 *    process imports every package and runs the probes together; then one
 *    process per package imports it alone. Then the bins.
 * 4. The consumer-wide checks in CONSUMER_CHECKS, against that install.
 * 5. Typecheck the published type surface against that install.
 * 6. A second consumer for brain-ui-react on React 18.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { listPublishablePackages, type PublishablePackage } from "./publishable-packages";

/** The named probes in scripts/ci-pack-probe.mjs, run inside the consumer. */
export const PROBES = ["geo-static-map", "claude-backend-export", "core-testing-suites", "ui-kit-brand", "travel-cli"] as const;
export type Probe = (typeof PROBES)[number];
/**
 * Probes that run in a Bun process of their own, as they always did, rather
 * than inside the combined Bun pass: the travel CLI fixture spawns the packed
 * `brain` bin against a scratch brain.
 */
export const OWN_PROCESS: readonly Probe[] = ["travel-cli"];
/** The named bin probes in BIN_PROBES below. */
export const BIN_PROBE_NAMES = ["brain-version", "brain-ui-cron-usage"] as const;
export type BinProbe = (typeof BIN_PROBE_NAMES)[number];

export interface PackRow {
  /**
   * Entries the tarball must hold, relative to its `package/` root. A path
   * ending in `/` asks for at least one entry under that directory.
   */
  files: string[];
  /** Specifiers the Bun consumer imports. */
  bun: string[];
  bunProbes?: Probe[];
  /**
   * Specifiers the Node consumer imports, or `"bun-only"` for a package whose
   * root documents a `bun:` dependency: its root must then load under Node or
   * fail only on that. check-dist-types.ts reads the same partition to pick
   * the consumer's type setup.
   */
  node: string[] | "bun-only";
  nodeProbes?: Probe[];
  bins?: BinProbe[];
  /** Installed into the React 18 consumer: brain-ui-react and what it needs. */
  react18?: true;
}

/** Keyed by directory under `packages/`, which is also the tarball's name. */
export const PACK_TABLE: Record<string, PackRow> = {
  common: {
    // Internal-only: two ./internal/* entries and no root entry.
    files: ["dist/env-core.js", "dist/frontmatter-parse.js"],
    bun: ["@schlessera/brain-common/internal/frontmatter"],
    node: ["@schlessera/brain-common/internal/env", "@schlessera/brain-common/internal/frontmatter"],
    react18: true,
  },
  geo: {
    files: ["dist/index.js", "assets/IBMPlexSans-Regular.ttf", "assets/IBMPlexSans-Medium.ttf", "assets/OFL.txt"],
    bun: ["@schlessera/brain-geo"],
    bunProbes: ["geo-static-map"],
    node: ["@schlessera/brain-geo", "@schlessera/brain-geo/server"],
    nodeProbes: ["geo-static-map"],
    react18: true,
  },
  core: {
    // Codex reads a skill's manual-only policy from beside its SKILL.md.
    files: ["dist/index.js", "dist/cli/brain.js", "dist/hooks/", "skills/sync/agents/openai.yaml"],
    bun: ["@schlessera/brain"],
    bunProbes: ["core-testing-suites"],
    node: "bun-only",
    nodeProbes: ["core-testing-suites"],
    bins: ["brain-version"],
  },
  "ui-sdk": {
    files: ["dist/index.js"],
    bun: ["@schlessera/brain-ui-sdk"],
    node: [
      "@schlessera/brain-ui-sdk",
      "@schlessera/brain-ui-sdk/protocol",
      "@schlessera/brain-ui-sdk/schemas",
      "@schlessera/brain-ui-sdk/server",
      "@schlessera/brain-ui-sdk/testing",
      "@schlessera/brain-ui-sdk/client",
    ],
    react18: true,
  },
  "ui-backend-claude": {
    files: ["dist/index.js"],
    bun: ["@schlessera/brain-backend-claude"],
    bunProbes: ["claude-backend-export"],
    node: ["@schlessera/brain-backend-claude"],
  },
  "ui-backend-pi": {
    files: ["dist/index.js"],
    bun: ["@schlessera/brain-backend-pi"],
    node: "bun-only",
  },
  "ui-render-puppeteer": {
    files: ["dist/index.js"],
    bun: ["@schlessera/brain-render-puppeteer"],
    node: ["@schlessera/brain-render-puppeteer"],
  },
  "render-template": {
    files: ["dist/index.js"],
    bun: ["@schlessera/brain-render-template"],
    node: ["@schlessera/brain-render-template"],
    react18: true,
  },
  scrape: {
    files: ["dist/index.js"],
    bun: ["@schlessera/brain-scrape"],
    node: ["@schlessera/brain-scrape"],
  },
  "ui-server": {
    files: ["dist/index.js", "dist/bin/brain-ui-cron.js", "dist/bin/brain-ui-inbox.js"],
    bun: ["@schlessera/brain-ui-server"],
    node: "bun-only",
    bins: ["brain-ui-cron-usage"],
  },
  "ui-kit": {
    files: ["dist/index.js"],
    bun: ["@schlessera/brain-ui-kit"],
    node: ["@schlessera/brain-ui-kit"],
    nodeProbes: ["ui-kit-brand"],
    react18: true,
  },
  "ui-react": {
    files: ["dist/index.js"],
    bun: ["@schlessera/brain-ui-react"],
    node: ["@schlessera/brain-ui-react"],
    react18: true,
  },
  "module-finance": { files: ["dist/index.js"], bun: ["@schlessera/brain-module-finance"], node: "bun-only" },
  "module-images": { files: ["dist/index.js"], bun: ["@schlessera/brain-module-images"], node: "bun-only" },
  "module-video": { files: ["dist/index.js"], bun: ["@schlessera/brain-module-video"], node: "bun-only" },
  "module-jobs": { files: ["dist/index.js"], bun: ["@schlessera/brain-module-jobs"], node: "bun-only" },
  "module-speaking": {
    files: ["dist/index.js", "skills/new-submission/agents/openai.yaml"],
    bun: ["@schlessera/brain-module-speaking"],
    node: "bun-only",
  },
  "module-travel": {
    files: ["dist/index.js", "skills/plan-travel/SKILL.md", "skills/trip-log/SKILL.md", "skills/places/SKILL.md"],
    bun: ["@schlessera/brain-module-travel"],
    // Runs with the speaking module's travel party, both packed.
    bunProbes: ["travel-cli"],
    node: "bun-only",
  },
};

/** Whole-install checks run against the main consumer, in order. */
export const CONSUMER_CHECKS: ReadonlyArray<{ name: string; script: string }> = [
  { name: "packed query source and default JavaScript imports", script: "check-query-package.ts" },
  { name: "packed pi graph and listing tool runtime", script: "check-pi-query-package.ts" },
  { name: "packed ui-server graph and keyterms through the optional core peer", script: "check-ui-server-query-package.ts" },
  { name: "packed jobs hygiene through the packed core loader and queries", script: "check-module-query-package.ts" },
  { name: "packed operational backup and restore commands", script: "check-inbox-package.ts" },
];

export interface PackEntry { pkg: PublishablePackage; row: PackRow; }

/** What one probe process imports and runs (scripts/ci-pack-probe.mjs). */
export interface ProbeSpec { label: string; imports?: string[]; bunOnly?: string[]; probes?: Probe[]; }

/**
 * Every package loaded together, one process per runtime, as a consumer that
 * depends on all of them does: a duplicate global registration, a singleton
 * claimed twice or two copies of one dependency only fail when packages share
 * a process. The per-package passes after it attribute a failure and catch a
 * package that loads only because another one loaded first.
 */
export function combinedSpecs(entries: readonly PackEntry[]): { bun: ProbeSpec; node: ProbeSpec } {
  return {
    bun: {
      label: "every package together",
      imports: entries.flatMap(({ row }) => row.bun),
      probes: entries.flatMap(({ row }) => (row.bunProbes ?? []).filter(probe => !OWN_PROCESS.includes(probe))),
    },
    node: {
      label: "every package together",
      imports: entries.flatMap(({ row }) => (row.node === "bun-only" ? [] : row.node)),
      bunOnly: entries.flatMap(({ pkg, row }) => (row.node === "bun-only" ? [pkg.name] : [])),
      probes: entries.flatMap(({ row }) => row.nodeProbes ?? []),
    },
  };
}

/**
 * The publishable packages in publish order, each with its row. Throws on an
 * empty list, a package without a row, a row without a package, or a row that
 * cannot hold: a specifier from another package, no Bun import, no Node
 * expectation, or an importable root with no `dist/index.js` in its tarball.
 */
export function packPlan(root: string, table: Record<string, PackRow> = PACK_TABLE): PackEntry[] {
  const packages = listPublishablePackages(root);
  if (packages.length === 0) throw new Error(`No publishable packages found under ${join(root, "packages")}`);
  const problems: string[] = [];
  for (const pkg of packages) if (!table[pkg.dir]) problems.push(`packages/${pkg.dir} has no row in the pack table (scripts/ci-pack.ts)`);
  for (const dir of Object.keys(table)) {
    if (!packages.some(pkg => pkg.dir === dir)) problems.push(`the pack table row ${dir} names no publishable package`);
  }
  for (const pkg of packages) {
    const row = table[pkg.dir];
    if (!row) continue;
    const own = (specifier: string) => specifier === pkg.name || specifier.startsWith(`${pkg.name}/`);
    const specifiers = [...row.bun, ...(row.node === "bun-only" ? [] : row.node)];
    for (const specifier of specifiers.filter(s => !own(s))) problems.push(`${pkg.dir}: ${specifier} is not a ${pkg.name} specifier`);
    if (row.bun.length === 0) problems.push(`${pkg.dir}: no Bun import`);
    if (row.node !== "bun-only" && row.node.length === 0) problems.push(`${pkg.dir}: no Node import and not bun-only`);
    if ((row.bun.includes(pkg.name) || row.node === "bun-only") && !row.files.includes("dist/index.js")) {
      problems.push(`${pkg.dir}: its root is imported but dist/index.js is not a required tarball entry`);
    }
  }
  if (problems.length) throw new Error(`The pack table does not match the publishable packages:\n  ${problems.join("\n  ")}`);
  return packages.map(pkg => ({ pkg, row: table[pkg.dir]! }));
}

/** The required entries a tarball listing lacks. */
export function missingEntries(listing: readonly string[], files: readonly string[]): string[] {
  return files.filter(file => file.endsWith("/")
    ? !listing.some(entry => entry.startsWith(`package/${file}`) && entry.length > `package/${file}`.length)
    : !listing.includes(`package/${file}`));
}

/** A consumer manifest resolving each listed package to its packed tarball. */
export function consumerManifest(name: string, entries: readonly PackEntry[]): object {
  return {
    name, private: true, type: "module",
    overrides: Object.fromEntries(entries.map(({ pkg }) => [pkg.name, `file:../brainkit-tarballs/${pkg.dir}.tgz`])),
  };
}

/** The `brain-ui-cron` usage problems in its no-argument output. */
export function cronUsageProblems(status: number, usage: string): string[] {
  const problems: string[] = [];
  if (status !== 2) problems.push(`brain-ui-cron with no arguments exited ${status}, expected 2`);
  // One line per subcommand, so adding a subcommand does not silently stop
  // this from asserting anything. The `run` line is the one the container
  // crontab is written against, so it is matched in full.
  //
  // Matching in full means this has to move when the line does, and it did
  // not: `--subprocess-env-extra` was added to `run` by the 0.33.1
  // per-audience allowlist and this string was left behind, so the job failed
  // from then until the lockfile break started masking it. The emitter's own
  // byte-exact goldens are in packages/ui-server/tests/cron-emit.test.ts; this
  // assertion is about the packed bin's advertised interface.
  const run = "usage: brain-ui-cron run [--subprocess-env-extra <names>] <job-name> -- <command...>";
  if (!usage.includes(run)) problems.push(`brain-ui-cron usage lacks: ${run}`);
  for (const sub of ["digest", "crontab", "environment"]) {
    if (!new RegExp(`^ *brain-ui-cron ${sub}( |$)`, "m").test(usage)) problems.push(`brain-ui-cron usage lacks its ${sub} line`);
  }
  return problems;
}

/**
 * Every resolution of an internal package in a consumer's bun.lock, nested
 * copies included, must be a packed tarball: a nested npm copy would be the
 * one a dependant actually loads. Neither a version nor a manifest can tell a
 * tarball from the same release on npm, which is byte-identical when nothing
 * changed since publishing. The lockfile can.
 */
export function lockProblems(lock: string, entries: readonly PackEntry[]): string[] {
  const problems: string[] = [];
  for (const [, name, from] of lock.matchAll(/\["(@schlessera\/[^@"]+)@([^"]*)"/g)) {
    if (!from!.startsWith("../brainkit-tarballs/")) problems.push(`${name} resolved from ${from || "the registry"}, not a packed tarball`);
  }
  for (const { pkg } of entries) {
    const entry = `"${pkg.name}": ["${pkg.name}@../brainkit-tarballs/${pkg.dir}.tgz"`;
    if (!lock.includes(entry)) problems.push(`${pkg.name} did not resolve to ${pkg.dir}.tgz`);
  }
  return problems;
}

const ROOT = resolve(import.meta.dir, "..");

/**
 * The Node the probes run under, resolved once from the PATH this script was
 * given — the one check-packages.ts gated and setup-node installed — and used
 * by absolute path, so nothing added to a child's PATH can substitute another.
 */
let resolvedNode: string | undefined;
async function node(): Promise<string> {
  if (resolvedNode) return resolvedNode;
  const found = Bun.which("node");
  if (!found) throw new Error("The packed Node probes need node on PATH");
  const release = Bun.spawnSync([found, "-p", "process.release.name + ' ' + process.version"], { stdout: "pipe", stderr: "pipe" });
  const [name, version] = new TextDecoder().decode(release.stdout).trim().split(" ");
  if (release.exitCode !== 0 || name !== "node") throw new Error(`${found} is not Node (${name ?? "no release name"})`);
  console.log(`Node probes run under ${found} ${version}`);
  return (resolvedNode = found);
}
const PROBE = ".brainkit-pack-probe.mjs";

async function run(label: string, argv: string[], cwd: string, capture = false): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(argv, {
    cwd, stdin: "ignore", stdout: capture ? "pipe" : "inherit", stderr: capture ? "pipe" : "inherit",
    // The job's environment: no provider key reaches a packed probe.
    // Appended, not prepended: a bun for bins with an `env bun` shebang, never
    // a replacement for anything already on PATH.
    env: { ...process.env, PATH: `${process.env.PATH ?? ""}:${dirname(process.execPath)}`, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "" },
  });
  const [out, err, code] = await Promise.all([
    capture ? new Response(child.stdout as ReadableStream).text() : "",
    capture ? new Response(child.stderr as ReadableStream).text() : "",
    child.exited,
  ]);
  if (!capture && code !== 0) throw new Error(`${label} failed (${code})`);
  return { code, output: out + err };
}

function fail(label: string, problems: string[]): void {
  if (problems.length) throw new Error(`${label}:\n  ${problems.join("\n  ")}`);
}

async function phase(name: string, body: () => Promise<void>): Promise<void> {
  const actions = process.env.GITHUB_ACTIONS === "true";
  console.log(actions ? `::group::${name}` : `\n== ${name}`);
  try { await body(); }
  catch (error) { throw new Error(`Pack phase "${name}" failed: ${error instanceof Error ? error.message : error}`); }
  finally { if (actions) console.log("::endgroup::"); }
}

async function probe(consumer: string, runtime: "bun" | "node", spec: ProbeSpec): Promise<void> {
  const executable = runtime === "bun" ? process.execPath : await node();
  await run(`${spec.label} under ${runtime}`, [executable, PROBE, JSON.stringify(spec)], consumer);
}

export const BIN_PROBES: Record<BinProbe, (consumer: string) => Promise<void>> = {
  "brain-version": async consumer => { await run("brain --version", ["./node_modules/.bin/brain", "--version"], consumer); },
  "brain-ui-cron-usage": async consumer => {
    const { code, output } = await run("brain-ui-cron", ["./node_modules/.bin/brain-ui-cron"], consumer, true);
    fail("Packed brain-ui-cron usage", cronUsageProblems(code, output));
    console.log("brain-ui-cron: usage ok");
  },
};

export async function ciPack(root: string, work: string): Promise<void> {
  const entries = packPlan(root);
  const bun = process.execPath;
  const tarballs = join(work, "brainkit-tarballs");
  const consumer = join(work, "brainkit-consumer");
  const react18 = join(work, "brainkit-react18-consumer");
  for (const dir of [tarballs, consumer, react18]) { rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true }); }
  console.log(`Packing: ${entries.map(({ pkg }) => pkg.dir).join(" ")}`);

  // The release-time probe, run on every PR: packs each package and asserts
  // every internal dep pin equals the current workspace version. Must run
  // BEFORE the consumers below, whose file: overrides resolve every internal
  // dep to a local tarball and would mask a wrong pin. No registry access.
  await phase("Workspace pins match the packed manifests", async () => {
    await run("check-publish-pins", [bun, join(root, "scripts/check-publish-pins.ts")], root);
  });

  await phase("Pack every publishable package and check its entries", async () => {
    for (const { pkg, row } of entries) {
      const tarball = join(tarballs, `${pkg.dir}.tgz`);
      await run(`pack ${pkg.dir}`, [bun, "pm", "pack", "--filename", tarball], join(root, "packages", pkg.dir));
      const listing = await run(`list ${pkg.dir}.tgz`, ["tar", "-tzf", tarball], root, true);
      if (listing.code !== 0) throw new Error(`tar could not list ${pkg.dir}.tgz: ${listing.output}`);
      fail(`${pkg.dir}.tgz lacks required entries`, missingEntries(listing.output.split("\n"), row.files));
    }
  });

  await phase("Install and smoke-test the packed packages", async () => {
    writeFileSync(join(consumer, "package.json"), JSON.stringify(consumerManifest("brainkit-pack-smoke", entries), null, 2) + "\n");
    await run("consumer install", [bun, "add", ...entries.map(({ pkg }) => join(tarballs, `${pkg.dir}.tgz`)), "react", "react-dom"], consumer);
    cpSync(join(root, "scripts/ci-pack-probe.mjs"), join(consumer, PROBE));
    const combined = combinedSpecs(entries);
    await probe(consumer, "bun", combined.bun);
    for (const { pkg, row } of entries) {
      const own = (row.bunProbes ?? []).filter(name => OWN_PROCESS.includes(name));
      if (own.length) await probe(consumer, "bun", { label: `${pkg.dir} ${own.join(", ")}`, probes: own });
    }
    await probe(consumer, "node", combined.node);
    for (const { pkg, row } of entries) {
      await probe(consumer, "bun", { label: pkg.dir, imports: row.bun });
      await probe(consumer, "node", row.node === "bun-only" ? { label: pkg.dir, bunOnly: [pkg.name] } : { label: pkg.dir, imports: row.node });
    }
    for (const { row } of entries) for (const bin of row.bins ?? []) await BIN_PROBES[bin](consumer);
  });

  for (const check of CONSUMER_CHECKS) {
    await phase(`Check ${check.name}`, async () => {
      await run(check.script, [bun, join(root, "scripts", check.script), "--root", consumer], root);
    });
  }

  // The repo's own typecheck resolves cross-package imports to src via
  // customConditions ["bun"], so the emitted .d.ts consumers get is otherwise
  // never typechecked — and the workspace's hoisted node_modules would let an
  // UNDECLARED dependency of a .d.ts resolve anyway. Running the probes
  // against the tarball-consumer install (which holds only declared
  // dependencies) closes both holes. The @types packages are the
  // consumer-side typing setup our optional peers and React peer deps
  // document. See scripts/check-dist-types.ts.
  await phase("Typecheck the published type surface (dist .d.ts, consumer conditions)", async () => {
    await run("consumer @types install", [bun, "add", "-d", "@types/bun", "@types/react", "@types/react-dom"], consumer);
    await run("check-dist-types", [bun, join(root, "scripts/check-dist-types.ts"), "--root", consumer], root);
  });

  // The primary consumer above follows the current React release. This narrow
  // second consumer keeps the package's >=18 peer claim honest without
  // reinstalling or rechecking the complete package matrix. The packed
  // brain-ui-react pins its internal dependencies to the workspace version,
  // which npm does not have between versioning and publishing, so the same
  // file: overrides make every internal package resolve to its packed tarball.
  await phase("Smoke-test brain-ui-react against React 18", async () => {
    const needed = entries.filter(({ row }) => row.react18);
    writeFileSync(join(react18, "package.json"), JSON.stringify(consumerManifest("brainkit-react18-smoke", needed), null, 2) + "\n");
    await run("React 18 install", [bun, "add", ...needed.map(({ pkg }) => join(tarballs, `${pkg.dir}.tgz`)), "react@^18", "react-dom@^18"], react18);
    await run("React 18 types install", [bun, "add", "-d", "@types/react@^18", "@types/react-dom@^18"], react18);
    const version = (JSON.parse(readFileSync(join(root, "packages/ui-react/package.json"), "utf8")) as { version: string }).version;
    const problems = lockProblems(readFileSync(join(react18, "bun.lock"), "utf8"), needed);
    const installed = (name: string) => (JSON.parse(readFileSync(join(react18, "node_modules", name, "package.json"), "utf8")) as { version: string }).version;
    for (const { pkg } of needed) {
      if (installed(pkg.name) !== version) problems.push(`${pkg.name} is ${installed(pkg.name)}, expected the workspace version ${version}`);
    }
    for (const name of ["react", "react-dom", "@types/react", "@types/react-dom"]) {
      if (!installed(name).startsWith("18.")) problems.push(`Expected ${name} 18.x, got ${installed(name)}`);
    }
    fail("The React 18 consumer did not install the packed packages on React 18", problems);
    cpSync(join(root, "scripts/ci-pack-probe.mjs"), join(react18, PROBE));
    for (const runtime of ["bun", "node"] as const) {
      await probe(react18, runtime, { label: "ui-react on React 18", imports: ["@schlessera/brain-ui-react"] });
    }
    writeFileSync(join(react18, "index.ts"), `import * as ui from "@schlessera/brain-ui-react";\nui;\n`);
    writeFileSync(join(react18, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, skipLibCheck: false,
        noEmit: true, lib: ["ESNext", "DOM", "DOM.Iterable"], jsx: "react-jsx", types: [],
      },
      include: ["index.ts"],
    }, null, 2) + "\n");
    await run("React 18 typecheck", [join(root, "node_modules/.bin/tsc"), "-p", "tsconfig.json", "--pretty", "false"], react18);
  });
}

if (import.meta.main) {
  const owned = !process.env.RUNNER_TEMP;
  const work = process.env.RUNNER_TEMP ?? mkdtempSync(join(tmpdir(), "brainkit-pack-"));
  try {
    await ciPack(ROOT, work);
    console.log("\nEvery publishable package packed, installed and passed its probes.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    if (owned) rmSync(work, { recursive: true, force: true });
  }
}
