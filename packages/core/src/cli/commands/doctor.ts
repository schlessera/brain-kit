import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve, sep } from "path";

import { readEnvVar, resolveEnv } from "../../config/env.js";
import {
  openDatabase,
  loadVecSupport,
  migrateVecSchema,
  storedVectorWidth,
  getMeta,
  embeddingIdentityMatches,
  SCHEMA_VERSION as EXPECTED_SCHEMA_VERSION,
} from "../../lib/db.js";
import { indexAll, getMarkdownFiles } from "../../lib/indexer.js";
import { DEFAULT_INSTRUCTIONS_MAX_TOKENS } from "../../lib/config.js";
import { measureInstructions } from "../../lib/instructions-weight.js";
import { discoverSkills, syncSkills, installBinLinks } from "../../lib/skills/index.js";
import { packageVersion } from "../../package-version.js";
import type { CoreCommand, CliContext } from "../types.js";
import { emit, embeddingDims, parseArgs } from "../io.js";
import { resolveEmitters } from "../skills-util.js";
import { GIT_MISSING, HOOK_NAMES, gitInstalled, installGitHooks, isGitRepo, packagedHooksDir } from "../hooks-util.js";
import { isToolLeftover } from "../../lib/tool-leftovers.js";
import { ignoreScratch, SCRATCH_DIR, ScratchRedirectedError, scratchIgnored } from "../../lib/scratch.js";
import { WriteRefusedError } from "../../lib/safe-path.js";
import { builtFtsTokenizer, ftsTokenizer } from "../../lib/search-language.js";
import { cachesWithoutPortableUnionMerge, cachesWithoutUnionMerge, unionMergeCaches } from "../../lib/cache-attributes.js";
import { isGitWorkTree, looseObjects, originalRefs } from "../../lib/git-storage.js";

const HELP = `brain doctor — health check battery

  --fix                   Apply the auto-fixable checks (hooks, symlinks, index,
                          deps, mcp, scratch, cache-merge), then re-run and
                          report.

--json: { "checks": [{ "id", "status": "pass"|"warn"|"fail", "detail", "fix"? }] }`;

const MIN_BUN = [1, 3, 5];

type Status = "pass" | "warn" | "fail";
interface Check {
  id: string;
  status: Status;
  detail: string;
  fix?: string;
}

/** Whether `cmd` is on PATH. Looked up, not spawned: a shell may be missing too. */
function which(cmd: string): boolean {
  return Bun.which(cmd) !== null;
}

function gitConfig(root: string, key: string): string {
  return new TextDecoder().decode(Bun.spawnSync(["git", "-C", root, "config", "--get", key]).stdout).trim();
}

function cmpSemver(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

/** Whether `path` is a directory now; false when it is missing or vanishes mid-check. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// --- individual checks -----------------------------------------------------

function checkRuntime(): Check {
  const v = process.versions.bun;
  if (!v) return { id: "runtime", status: "fail", detail: "not running under Bun", fix: "install Bun (https://bun.sh)" };
  const parts = v.split(".").map((n) => parseInt(n, 10));
  if (cmpSemver(parts, MIN_BUN) < 0) {
    return { id: "runtime", status: "warn", detail: `Bun ${v} is older than ${MIN_BUN.join(".")} (CVE-2026-24910)`, fix: "upgrade Bun" };
  }
  return { id: "runtime", status: "pass", detail: `Bun ${v}` };
}

export function checkGitHooks(root: string, packaged = packagedHooksDir()): Check {
  if (!gitInstalled()) return { id: "git-hooks", status: "warn", detail: GIT_MISSING, fix: "install git, then run `brain setup`" };
  if (!isGitRepo(root)) return { id: "git-hooks", status: "warn", detail: "not a git repository", fix: "run `git init`, then `brain setup`" };
  const hooksPath = gitConfig(root, "core.hooksPath");
  if (!hooksPath) return { id: "git-hooks", status: "fail", detail: "core.hooksPath is not set", fix: "run `brain setup`" };
  const resolvedHooksPath = resolve(root, hooksPath);
  if (!isDirectory(resolvedHooksPath)) {
    return {
      id: "git-hooks",
      status: "fail",
      detail: `core.hooksPath points to a missing directory: ${resolvedHooksPath}`,
      fix: "run `brain setup`",
    };
  }
  const hooks = HOOK_NAMES.filter((name) => {
    const path = join(resolvedHooksPath, name);
    try {
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
  if (hooks.length === 0) {
    return {
      id: "git-hooks",
      status: "fail",
      detail: `core.hooksPath contains no hook files: ${resolvedHooksPath}`,
      fix: "run `brain setup`",
    };
  }
  // Installed hooks are copies, and nothing updates a copy when the package
  // does, so compare each with the one this package ships.
  const { missing, differing, unverified } = compareHooks(resolvedHooksPath, packaged);
  if (unverified.length > 0) {
    // Without the packaged copy there is nothing to compare with, and nothing
    // --fix could install: the package itself is incomplete.
    return {
      id: "git-hooks",
      status: "fail",
      detail: `cannot verify ${unverified.map((u) => u.name).join(", ")}: the packaged hook is missing or unreadable (${unverified.map((u) => u.reason).join("; ")})`,
      fix: "reinstall @schlessera/brain (`bun install`), then run `brain doctor --fix`",
    };
  }
  if (missing.length > 0 || differing.length > 0) {
    const parts = [
      ...(differing.length > 0 ? [`differ from the packaged ones: ${differing.join(", ")}`] : []),
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
    ];
    return {
      id: "git-hooks",
      status: "warn",
      detail: `hooks in ${hooksPath} ${parts.join("; ")}`,
      fix: "run `brain doctor --fix` or `brain setup` to reinstall the packaged hooks",
    };
  }
  return {
    id: "git-hooks",
    status: "pass",
    detail: `core.hooksPath = ${hooksPath} (${hooks.length} hook file(s), matching the packaged ones)`,
  };
}

/**
 * Each hook the package ships (HOOK_NAMES), against the copy in `installed`:
 * missing there, different there, or unverifiable because the packaged copy
 * itself cannot be read. An unreadable installed copy counts as missing,
 * which --fix repairs by reinstalling.
 */
function compareHooks(
  installed: string,
  packaged: string
): { missing: string[]; differing: string[]; unverified: { name: string; reason: string }[] } {
  const missing: string[] = [];
  const differing: string[] = [];
  const unverified: { name: string; reason: string }[] = [];
  for (const name of HOOK_NAMES) {
    let shipped: Buffer;
    try {
      shipped = readFileSync(join(packaged, name));
    } catch (e) {
      unverified.push({ name, reason: (e as NodeJS.ErrnoException).code ?? (e as Error).message });
      continue;
    }
    let copy: Buffer;
    try {
      copy = readFileSync(join(installed, name));
    } catch {
      missing.push(name);
      continue;
    }
    if (!copy.equals(shipped)) differing.push(name);
  }
  return { missing, differing, unverified };
}

function checkSymlinks(root: string): Check {
  const broken: string[] = [];
  const binDir = resolveEnv().binDir;
  const binLink = join(binDir, "brain");
  try {
    if (lstatSync(binLink).isSymbolicLink() && !existsSync(binLink)) broken.push(binLink);
  } catch {
    /* not linked at all — not broken, just absent */
  }
  const skillsDir = join(root, ".claude", "skills");
  let entries: string[] = [];
  let unreadable: string | undefined;
  if (existsSync(skillsDir)) {
    try {
      entries = readdirSync(skillsDir);
    } catch (e) {
      unreadable = `could not read .claude/skills: ${(e as Error).message}`;
    }
  }
  for (const entry of entries) {
    const p = join(skillsDir, entry);
    try {
      if (lstatSync(p).isSymbolicLink() && !existsSync(p)) broken.push(`.claude/skills/${entry}`);
    } catch {
      /* ignore */
    }
  }
  if (unreadable) {
    const also = broken.length > 0 ? `; also broken: ${broken.join(", ")}` : "";
    return { id: "symlinks", status: "warn", detail: unreadable + also, fix: "make .claude/skills a readable directory, then run `brain skills sync`" };
  }
  if (broken.length > 0) {
    return { id: "symlinks", status: "warn", detail: `${broken.length} stale/broken symlink(s): ${broken.slice(0, 3).join(", ")}`, fix: "run `brain skills sync`" };
  }
  return { id: "symlinks", status: "pass", detail: "no broken symlinks" };
}

/**
 * `.claude/commands/<name>.md` files that a skill of the same name shadows.
 * Claude Code runs the skill, so the command file is dead but still looks
 * authoritative to whoever edits it. A command in a subdirectory is named
 * `<dir>:<name>` (`frontend/component.md` is `/frontend:component`), so only
 * a skill with that full name shadows it.
 */
function checkShadowedCommands(cli: CliContext): Check {
  const root = cli.brain.root;
  const commandsDir = join(root, ".claude", "commands");
  if (!existsSync(commandsDir)) {
    return { id: "shadowed-commands", status: "pass", detail: "no .claude/commands directory" };
  }
  const unreadable = (reason: string): Check => ({
    id: "shadowed-commands",
    status: "warn",
    detail: `could not read .claude/commands: ${reason}`,
    fix: "make .claude/commands a readable directory, or remove it",
  });
  if (!isDirectory(commandsDir)) return unreadable("it is not a directory");
  const shadowed: string[] = [];
  try {
    const skills = new Set(discoverSkills({ root, modules: cli.brain.modules }).skills.map((s) => s.name));
    for (const rel of new Bun.Glob("**/*.md").scanSync({ cwd: commandsDir })) {
      const name = rel.replace(/\.md$/, "").split(/[\\/]/).join(":");
      if (skills.has(name)) shadowed.push(`.claude/commands/${rel.split(sep).join("/")}`);
    }
  } catch (e) {
    return unreadable((e as Error).message);
  }
  if (shadowed.length === 0) {
    return { id: "shadowed-commands", status: "pass", detail: "no command file shares a name with a skill" };
  }
  shadowed.sort();
  return {
    id: "shadowed-commands",
    status: "warn",
    detail: `${shadowed.length} command file(s) shadowed by a skill of the same name: ${shadowed.join(", ")}`,
    fix: "delete or rename each file; the skill runs, not the command",
  };
}

/**
 * What every session pays for before any work starts (see
 * lib/instructions-weight.ts), against `instructions.maxTokens`. Anything that
 * could not be measured makes the total a lower bound, so it warns even under
 * the limit.
 */
function checkInstructionsWeight(cli: CliContext): Check {
  const limit = cli.brain.config?.instructions?.maxTokens ?? DEFAULT_INSTRUCTIONS_MAX_TOKENS;
  let measured: ReturnType<typeof measureInstructions>;
  try {
    measured = measureInstructions(cli.brain.root, cli.brain.modules);
  } catch (e) {
    return { id: "instructions-weight", status: "warn", detail: `could not measure: ${(e as Error).message}` };
  }
  const { contributors, notes, problems } = measured;

  const total = contributors.reduce((sum, c) => sum + c.tokens, 0);
  const all = contributors.map((c) => `${c.name} ${c.tokens}`).join(", ") || "nothing";
  const over = total > limit;
  const lead = over
    ? `~${total} tokens always loaded, over the ${limit} limit; largest: ${[...contributors]
        .sort((a, b) => b.tokens - a.tokens || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .slice(0, 3)
        .map((c) => `${c.name} (${c.tokens})`)
        .join(", ")}. All: ${all}`
    : `~${total} tokens always loaded (limit ${limit}): ${all}`;
  const tail = [
    ...(problems.length > 0 ? [`not measured, so the total is a lower bound: ${problems.join("; ")}`] : []),
    ...notes,
  ];
  const detail = [lead, ...tail].join(". ");

  if (!over && problems.length === 0) return { id: "instructions-weight", status: "pass", detail };
  const fixes = [
    ...(problems.length > 0 ? ["fix or remove the imports and skills that could not be read"] : []),
    ...(over ? ["trim the largest files, move rules a session rarely needs into a skill, or raise `instructions.maxTokens` in brain.config"] : []),
  ];
  return { id: "instructions-weight", status: "warn", detail, fix: fixes.join("; ") };
}

function checkConfig(cli: CliContext): Check {
  if (cli.configError) return { id: "config", status: "fail", detail: `brain.config is invalid: ${cli.configError.split("\n")[0]}`, fix: "fix brain.config or re-run /brain-init" };
  if (!cli.brain.config) return { id: "config", status: "warn", detail: "no brain.config found (using core defaults)", fix: "run `brain init --default` or /brain-init" };
  return { id: "config", status: "pass", detail: `loaded ${cli.brain.configPath}` };
}

function checkDb(cli: CliContext): Check {
  if (!existsSync(cli.brain.dbPath)) return { id: "db", status: "fail", detail: "brain.db is missing", fix: "run `brain index`" };
  const db = openDatabase(cli.brain.dbPath, { readonly: true });
  try {
    const schema = parseInt(getMeta(db, "schema_version") ?? "0", 10);
    if (schema < EXPECTED_SCHEMA_VERSION) {
      return { id: "db", status: "warn", detail: `schema_version ${schema} < ${EXPECTED_SCHEMA_VERSION}`, fix: "run `brain index --force`" };
    }
    const rows = db.prepare("SELECT path, indexed_at FROM documents WHERE asset_type = 'markdown'").all() as { path: string; indexed_at: string }[];
    const indexed = new Map(rows.map((r) => [r.path, Date.parse(r.indexed_at)]));
    let stale = 0;
    const seen = new Set<string>();
    for (const path of getMarkdownFiles(cli.brain.root, cli.brain.taxonomy)) {
      seen.add(path);
      const at = indexed.get(path);
      try {
        if (at === undefined || statSync(resolve(cli.brain.root, path)).mtimeMs > at) stale++;
      } catch {
        /* vanished */
      }
    }
    for (const path of indexed.keys()) if (!seen.has(path)) stale++;
    if (stale > 0) return { id: "db", status: "warn", detail: `index is stale (${stale} file(s) newer than the index)`, fix: "run `brain index`" };
    return { id: "db", status: "pass", detail: `schema v${schema}, ${rows.length} document(s), index fresh` };
  } finally {
    db.close();
  }
}

async function checkEmbeddings(cli: CliContext): Promise<Check> {
  const keyEnv = (typeof cli.brain.config?.embeddings?.provider === "string" && cli.brain.config.embeddings?.apiKeyEnv) || "GEMINI_API_KEY";
  if (!readEnvVar(keyEnv)) {
    return { id: "embeddings", status: "warn", detail: `${keyEnv} not set — vector search disabled (FTS still works)`, fix: `set ${keyEnv} to enable semantic search` };
  }
  if (!existsSync(cli.brain.dbPath)) return { id: "embeddings", status: "warn", detail: "no index yet", fix: "run `brain index --embeddings`" };
  const db = openDatabase(cli.brain.dbPath, { readonly: true });
  try {
    const storedModel = getMeta(db, "embedding_model");
    if (
      cli.embeddings &&
      storedModel &&
      !embeddingIdentityMatches(storedModel, cli.embeddings.id)
    ) {
      return { id: "embeddings", status: "warn", detail: `stored vectors from '${storedModel}' but configured provider is '${cli.embeddings.id}'`, fix: "run `brain index --embeddings --force`" };
    }
    // `vec_chunks` is a sqlite-vec virtual table: without the extension loaded
    // into THIS connection, every query against it throws and the count reads
    // as zero — which reported "no vectors stored" for a perfectly healthy
    // index. Load the extension first. This connection is read-only and this
    // check only counts, so it must not reach for the migrating entry point.
    const vec = await loadVecSupport(db);
    if (vec.reason === "extension-unavailable") {
      return {
        id: "embeddings",
        status: "warn",
        detail: "sqlite-vec could not be loaded — vector count unknown, vector search disabled",
        fix: "reinstall dependencies (`bun install`) so sqlite-vec is available",
      };
    }

    let vecCount = 0;
    try {
      vecCount = (db.prepare("SELECT COUNT(*) as n FROM vec_chunks").get() as { n: number }).n;
    } catch {
      /* vec table absent */
    }
    if (vecCount === 0) return { id: "embeddings", status: "warn", detail: "API key set but no vectors stored", fix: "run `brain index --embeddings`" };
    return { id: "embeddings", status: "pass", detail: `${vecCount} vector(s), model ${storedModel ?? "?"}` };
  } finally {
    db.close();
  }
}

function checkMcpRegistration(
  registration: unknown,
  source: string,
  // null = only probe absolute paths. Relative args in ~/.claude.json resolve
  // against whatever cwd the MCP client uses, not the config's directory, so
  // probing them from here would produce false negatives.
  baseDir: string | null
): Check {
  const args =
    registration &&
    typeof registration === "object" &&
    Array.isArray((registration as { args?: unknown }).args)
      ? (registration as { args: unknown[] }).args
      : [];
  for (const arg of args) {
    if (typeof arg !== "string" || !/\.(?:[cm]?[jt]s)$/.test(arg)) continue;
    const path = isAbsolute(arg)
      ? arg
      : baseDir === null
        ? null
        : resolve(baseDir, arg);
    if (path === null) continue;
    if (!existsSync(path)) {
      return {
        id: "mcp",
        status: "fail",
        detail: `registered in ${source}, but referenced MCP file does not exist: ${path}`,
        fix: "register with `brain mcp` instead of a source-file path",
      };
    }
  }
  return { id: "mcp", status: "pass", detail: `registered in ${source}` };
}

function checkMcp(root: string): Check {
  const localMcp = join(root, ".mcp.json");
  if (existsSync(localMcp)) {
    try {
      const cfg = JSON.parse(readFileSync(localMcp, "utf-8"));
      if (cfg?.mcpServers?.brain) {
        return checkMcpRegistration(
          cfg.mcpServers.brain,
          "project .mcp.json",
          root
        );
      }
    } catch {
      /* fall through */
    }
  }
  const globalCfg = join(homedir(), ".claude.json");
  if (existsSync(globalCfg)) {
    try {
      const cfg = JSON.parse(readFileSync(globalCfg, "utf-8"));
      if (cfg?.mcpServers?.brain) {
        return checkMcpRegistration(
          cfg.mcpServers.brain,
          "~/.claude.json",
          null
        );
      }
    } catch {
      /* fall through */
    }
  }
  if (which("claude")) {
    const out = new TextDecoder().decode(
      Bun.spawnSync(["claude", "mcp", "list"], { timeout: 15_000 }).stdout
    );
    if (/\bbrain\b/.test(out)) return { id: "mcp", status: "pass", detail: "registered (claude mcp list)" };
    return { id: "mcp", status: "warn", detail: "brain MCP server not registered", fix: "run `claude mcp add brain -- bun node_modules/.bin/brain mcp`" };
  }
  return { id: "mcp", status: "warn", detail: "could not determine MCP registration (no .mcp.json / ~/.claude.json / claude CLI)", fix: "register the brain MCP server with your agent" };
}

function checkDeps(root: string): Check {
  const nm = join(root, "node_modules");
  if (!existsSync(nm)) {
    // Monorepo dev: node_modules may live at a workspace root above the brain.
    if (!existsSync(join(root, "..", "node_modules")) && !existsSync(join(root, "..", "..", "node_modules"))) {
      // Warn (not fail): if the CLI is running at all, @schlessera/brain resolved
      // — a locally-missing node_modules is advisory (git hooks/tests need it).
      return { id: "deps", status: "warn", detail: "node_modules not found in the brain repo", fix: "run `bun install`" };
    }
  }
  return { id: "deps", status: "pass", detail: "dependencies installed" };
}

function checkVersion(): Check {
  try {
    return { id: "version", status: "pass", detail: `@schlessera/brain ${packageVersion()}` };
  } catch {
    return { id: "version", status: "warn", detail: "could not read core package version" };
  }
}

/** Loose objects above this many bytes warn: `brain maintain` packs them. */
const LOOSE_OBJECTS_WARN_BYTES = 100 * 1024 * 1024;

/**
 * Git storage health, read-only. Loose objects are packed by `brain
 * maintain`. A `refs/original/` backup (left by `git filter-branch`) pins
 * everything the rewrite meant to drop; removing it cannot be undone, so the
 * command is shown as text and never run, not even by `--fix`.
 */
function checkGitStorage(root: string): Check {
  let loose;
  let backups: string[];
  try {
    if (!isGitWorkTree(root)) return { id: "git-storage", status: "pass", detail: "not a git repository" };
    loose = looseObjects(root);
    backups = originalRefs(root);
  } catch (e) {
    return { id: "git-storage", status: "warn", detail: `could not read git storage: ${(e as Error).message}` };
  }
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const problems: string[] = [];
  const fixes: string[] = [];
  if (loose.bytes > LOOSE_OBJECTS_WARN_BYTES) {
    problems.push(`${loose.count} loose object(s) use ${mb(loose.bytes)}`);
    fixes.push("run `brain maintain` to pack them");
  }
  if (backups.length > 0) {
    problems.push(`${backups.length} filter-branch backup ref(s) keep rewritten history alive: ${backups.join(", ")}`);
    fixes.push(
      "if the rewrite is final, delete them by hand — this cannot be undone: " +
        "`git for-each-ref --format='delete %(refname)' refs/original/ | git update-ref --stdin`"
    );
  }
  if (problems.length === 0) {
    return { id: "git-storage", status: "pass", detail: `${loose.count} loose object(s), ${mb(loose.bytes)}; no refs/original backups` };
  }
  return { id: "git-storage", status: "warn", detail: problems.join("; "), fix: fixes.join("; ") };
}

/**
 * A stored eval baseline recorded on another `@schlessera/brain` version is
 * a reminder, not a failure: upgrades arrive by version bump, and comparing
 * the new version's ranking against the old one is a step for a person.
 */
function checkEvalBaseline(root: string): Check {
  const path = join(root, "evals", "baseline.json");
  if (!existsSync(path)) return { id: "eval-baseline", status: "pass", detail: "no evals/baseline.json" };
  let version: unknown;
  try {
    version = (JSON.parse(readFileSync(path, "utf-8")) as { meta?: { version?: unknown } }).meta?.version;
  } catch (e) {
    return { id: "eval-baseline", status: "warn", detail: `evals/baseline.json could not be read: ${(e as Error).message}` };
  }
  const installed = packageVersion();
  if (version === installed) {
    return { id: "eval-baseline", status: "pass", detail: `evals/baseline.json matches the installed version (${installed})` };
  }
  return {
    id: "eval-baseline",
    status: "warn",
    detail: `evals/baseline.json was recorded with ${typeof version === "string" ? version : "an unknown version"}; ${installed} is installed`,
    fix: "run `brain eval --baseline evals/baseline.json`",
  };
}

function checkPrivacy(root: string): Check {
  if (!gitInstalled()) return { id: "privacy", status: "warn", detail: `${GIT_MISSING}, so the remote's visibility was not checked` };
  const hasRemote = Bun.spawnSync(["git", "-C", root, "remote", "get-url", "origin"]).exitCode === 0;
  if (!hasRemote) return { id: "privacy", status: "pass", detail: "no git remote (nothing published)" };
  if (!which("gh")) return { id: "privacy", status: "warn", detail: "git remote exists but gh CLI unavailable — verify the repo is PRIVATE manually" };
  const proc = Bun.spawnSync(["gh", "repo", "view", "--json", "visibility"], { cwd: root });
  if (proc.exitCode !== 0) return { id: "privacy", status: "warn", detail: "could not query repo visibility via gh" };
  try {
    const visibility = String(JSON.parse(new TextDecoder().decode(proc.stdout)).visibility || "").toUpperCase();
    if (visibility === "PUBLIC") {
      return { id: "privacy", status: "fail", detail: "the git remote is PUBLIC — a personal brain must stay private", fix: "make the repository private (gh repo edit --visibility private)" };
    }
    return { id: "privacy", status: "pass", detail: `repository visibility: ${visibility.toLowerCase()}` };
  } catch {
    return { id: "privacy", status: "warn", detail: "could not parse gh repo visibility" };
  }
}

async function checkSqliteVecMac(): Promise<Check> {
  if (process.platform !== "darwin") return { id: "sqlite-vec-macos", status: "pass", detail: "n/a (not macOS)" };
  try {
    const { load } = await import("sqlite-vec");
    const db = new Database(":memory:");
    load(db);
    db.prepare("SELECT vec_version()").get();
    db.close();
    return { id: "sqlite-vec-macos", status: "pass", detail: "sqlite-vec loads on this macOS SQLite" };
  } catch (e) {
    return {
      id: "sqlite-vec-macos",
      status: "warn",
      detail: `sqlite-vec cannot load: ${(e as Error).message}`,
      fix: "Apple's system SQLite blocks extensions — call Database.setCustomSQLite(<brew libsqlite3>) or `brew install sqlite`",
    };
  }
}

/**
 * `search.language` and the full-text index agree: the index was built with
 * the tokenizer the configured language names. A mismatch is repaired by the
 * next `brain index`, which rebuilds the table.
 */
function checkSearchLanguage(cli: CliContext): Check {
  const language = cli.brain.taxonomy.searchLanguage;
  const wanted = ftsTokenizer(language);
  if (!existsSync(cli.brain.dbPath)) {
    return { id: "search-language", status: "pass", detail: `search.language "${language}"; no index yet` };
  }
  let built: string | null = null;
  try {
    const db = new Database(cli.brain.dbPath, { readonly: true });
    try {
      built = builtFtsTokenizer(db);
    } finally {
      db.close();
    }
  } catch (e) {
    return { id: "search-language", status: "warn", detail: `could not read the index: ${(e as Error).message}` };
  }
  if (built === wanted) {
    return { id: "search-language", status: "pass", detail: `search.language "${language}", index tokenizer ${wanted}` };
  }
  return {
    id: "search-language",
    status: "warn",
    detail: `search.language "${language}" wants tokenizer ${wanted}, the index was built with ${built ?? "no full-text table"}`,
    fix: "run `brain index`, which rebuilds the full-text index",
  };
}

/**
 * The scratch area must be gitignored before anything writes there (#310),
 * or a render could land in the brain's history. Fixable: `--fix` adds the
 * line to `.gitignore`.
 */
/** `path` as one shell word: single-quoted unless it is plainly safe. */
function shellWord(path: string): string {
  return /^[\w./@+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Committed tool leftovers (OS metadata, editor swap files, LaTeX
 * byproducts): the same list `brain sync assess` treats as ARTIFACT and the
 * template `.gitignore` ignores. The fix is shown as text, never run: taking
 * a file out of the index is the user's call.
 */
function checkTrackedLeftovers(root: string): Check {
  if (!gitInstalled()) return { id: "tracked-leftovers", status: "warn", detail: GIT_MISSING };
  if (!isGitRepo(root)) return { id: "tracked-leftovers", status: "pass", detail: "not a git repository" };
  const proc = Bun.spawnSync(["git", "-C", root, "ls-files", "-z"]);
  if (proc.exitCode !== 0) {
    return { id: "tracked-leftovers", status: "warn", detail: `git ls-files failed: ${new TextDecoder().decode(proc.stderr).trim()}` };
  }
  const leftovers = new TextDecoder()
    .decode(proc.stdout)
    .split("\0")
    .filter((path) => path !== "" && isToolLeftover(path))
    .sort();
  if (leftovers.length === 0) return { id: "tracked-leftovers", status: "pass", detail: "no committed tool leftovers" };
  const shown = leftovers.slice(0, 10);
  const more = leftovers.length > shown.length ? ` and ${leftovers.length - shown.length} more` : "";
  return {
    id: "tracked-leftovers",
    status: "warn",
    detail: `${leftovers.length} committed tool leftover(s): ${shown.join(", ")}${more}`,
    // --literal-pathspecs: a file named `:(exclude)cv.aux` or `*.aux` is that
    // file, not a pathspec that selects others.
    fix: `untrack them (the files stay on disk), then commit: git --literal-pathspecs rm --cached -- ${shown.map(shellWord).join(" ")}`,
  };
}

function checkScratch(root: string): Check {
  if (!gitInstalled()) {
    return { id: "scratch", status: "warn", detail: `${GIT_MISSING}, so whether ${SCRATCH_DIR}/ is gitignored was not checked` };
  }
  try {
    if (scratchIgnored(root)) return { id: "scratch", status: "pass", detail: `${SCRATCH_DIR}/ is gitignored` };
  } catch (error) {
    if (error instanceof ScratchRedirectedError) {
      return { id: "scratch", status: "fail", detail: error.message, fix: "remove the symlink" };
    }
    throw error;
  }
  return {
    id: "scratch",
    status: "warn",
    detail: `${SCRATCH_DIR}/ is not gitignored, so renders and image drafts cannot be written there`,
    fix: "run `brain doctor --fix`",
  };
}

/**
 * The sidecar caches should union-merge in any git merge, not only in
 * `brain sync pull`, or a plain `git pull` conflicts on them. What counts is
 * the brain's own committed `.gitattributes`, which every clone gets; `--fix`
 * appends the `merge=union` lines there. A clone-local rule
 * (`info/attributes`, `core.attributesFile`) can neither stand in for a
 * missing committed rule nor be fixed by another line in the file, so one
 * that overrides the committed rule is reported on its own, with no fix.
 */
function checkCacheMerge(root: string): Check {
  let portable: string[];
  let effective: string[];
  try {
    portable = cachesWithoutPortableUnionMerge(root);
    effective = cachesWithoutUnionMerge(root);
  } catch (error) {
    return { id: "cache-merge", status: "warn", detail: (error as Error).message };
  }
  const list = (files: string[]) => files.join(" and ");
  if (portable.length > 0) {
    return {
      id: "cache-merge",
      status: "warn",
      detail: `.gitattributes gives ${list(portable)} no merge=union attribute, so a plain git merge conflicts on ${portable.length === 1 ? "it" : "them"}`,
      fix: "run `brain doctor --fix`",
    };
  }
  if (effective.length > 0) {
    return {
      id: "cache-merge",
      status: "warn",
      detail: `.gitattributes union-merges ${list(effective)}, but a rule local to this clone (.git/info/attributes or core.attributesFile) overrides it`,
      fix: "remove the overriding rule from .git/info/attributes or the file core.attributesFile names",
    };
  }
  return { id: "cache-merge", status: "pass", detail: "the sidecar caches union-merge (.gitattributes)" };
}

/**
 * Run one check, and report a check that throws as a `warn` naming its error
 * instead of losing the whole battery: a doctor that crashes tells the user
 * nothing about the checks that would have passed.
 */
export async function guarded(id: string, check: () => Check | Promise<Check>): Promise<Check> {
  try {
    return await check();
  } catch (e) {
    return { id, status: "warn", detail: `the check itself failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function runChecks(cli: CliContext): Promise<Check[]> {
  const root = cli.brain.root;
  const battery: [string, () => Check | Promise<Check>][] = [
    ["runtime", () => checkRuntime()],
    ["git-hooks", () => checkGitHooks(root)],
    ["symlinks", () => checkSymlinks(root)],
    ["shadowed-commands", () => checkShadowedCommands(cli)],
    ["instructions-weight", () => checkInstructionsWeight(cli)],
    ["config", () => checkConfig(cli)],
    ["db", () => checkDb(cli)],
    ["embeddings", () => checkEmbeddings(cli)],
    ["mcp", () => checkMcp(root)],
    ["deps", () => checkDeps(root)],
    ["version", () => checkVersion()],
    ["privacy", () => checkPrivacy(root)],
    ["eval-baseline", () => checkEvalBaseline(root)],
    ["git-storage", () => checkGitStorage(root)],
    ["tracked-leftovers", () => checkTrackedLeftovers(root)],
    ["scratch", () => checkScratch(root)],
    ["search-language", () => checkSearchLanguage(cli)],
    ["cache-merge", () => checkCacheMerge(root)],
    ["sqlite-vec-macos", () => checkSqliteVecMac()],
  ];
  const checks: Check[] = [];
  for (const [id, check] of battery) checks.push(await guarded(id, check));
  return checks;
}

/** Apply the auto-fixable checks currently not passing. Returns applied ids. */
async function applyFixes(cli: CliContext, checks: Check[]): Promise<string[]> {
  const root = cli.brain.root;
  const applied: string[] = [];
  const failing = new Set(checks.filter((c) => c.status !== "pass").map((c) => c.id));

  if (failing.has("git-hooks")) {
    // installGitHooks throws when the packaged hooks are missing (e.g. a
    // source checkout before `bun run build`) — record the failed fix and
    // keep running the rest of the battery.
    try {
      if (installGitHooks(root).installed) applied.push("git-hooks");
    } catch (e) {
      console.error(`doctor --fix: git-hooks fix failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (failing.has("scratch") && gitInstalled()) {
    // A symlinked scratch is not fixable by a line; the check already said so.
    // Without git, whether the line is needed cannot be asked.
    try {
      if (ignoreScratch(root)) applied.push("scratch");
    } catch (e) {
      // Anything else (a `.brain` that is a file, say) is reported by the check
      // too; record it and keep going rather than lose the rest of the fixes.
      const reason = e instanceof ScratchRedirectedError || e instanceof WriteRefusedError ? "refused" : "failed";
      console.error(`doctor --fix: scratch fix ${reason}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failing.has("cache-merge")) {
    try {
      if (unionMergeCaches(root)) applied.push("cache-merge");
    } catch (e) {
      console.error(`doctor --fix: cache-merge fix failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (failing.has("symlinks")) {
    // A `.claude/skills` that is not a directory makes the sync throw; the
    // check already said what to do, so record it and keep going.
    try {
      const { emitters } = resolveEmitters(cli.brain);
      syncSkills({ root, modules: cli.brain.modules }, { emitters });
      installBinLinks(root);
      applied.push("symlinks");
    } catch (e) {
      console.error(`doctor --fix: symlinks fix failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (failing.has("deps")) {
    Bun.spawnSync(["bun", "install"], { cwd: root });
    applied.push("deps");
  }
  if (failing.has("db") || failing.has("embeddings")) {
    const dims = embeddingDims(cli.embeddings);
    const db = openDatabase(cli.brain.dbPath, { embeddingDimensions: dims });
    await migrateVecSchema(db, storedVectorWidth(db, dims));
    const wantEmbeddings = !!cli.embeddings;
    await indexAll(db, {
      root,
      taxonomy: cli.brain.taxonomy,
      force: false,
      quiet: true,
      embeddings: wantEmbeddings,
      provider: wantEmbeddings ? cli.embeddings : undefined,
      enrichment: wantEmbeddings ? cli.enrichment : undefined,
    });
    db.close();
    if (failing.has("db")) applied.push("db");
    if (failing.has("embeddings") && wantEmbeddings) applied.push("embeddings");
  }
  if (failing.has("mcp") && which("claude")) {
    const brainBin = resolve(root, "node_modules/.bin/brain");
    Bun.spawnSync(
      ["claude", "mcp", "add", "brain", "--", "bun", brainBin, "mcp"],
      { cwd: root }
    );
    applied.push("mcp");
  }

  return applied;
}

export const doctorCommand: CoreCommand = {
  summary: "Run the health check battery (add --fix to auto-repair)",
  helpBlock: HELP,
  async run(args, cli): Promise<void> {
    const { flags } = parseArgs(args);

    let checks = await runChecks(cli);
    let applied: string[] = [];
    if (flags.fix === true) {
      applied = await applyFixes(cli, checks);
      checks = await runChecks(cli); // re-run to reflect the repairs
    }

    emit(cli.json, { checks, ...(flags.fix === true ? { fixesApplied: applied } : {}) }, () => {
      console.log("brain doctor:\n");
      for (const c of checks) {
        const mark = c.status === "pass" ? "ok  " : c.status === "warn" ? "warn" : "FAIL";
        console.log(`  [${mark}] ${c.id.padEnd(18)} ${c.detail}`);
        if (c.status !== "pass" && c.fix) console.log(`         fix: ${c.fix}`);
      }
      if (flags.fix === true) console.log(`\nFixes applied: ${applied.length ? applied.join(", ") : "none"}`);
    });

    // Doctor is a diagnostic report (exit 0). Failures are conveyed in the
    // `checks` array — the skill reads them and repairs with consent.
  },
};
