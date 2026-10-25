/**
 * Translating a provider rule's document types into folder masks (#2694,
 * option C). A type maps onto folders only through the brain's taxonomy, which
 * lives in `brain.config.ts`: the host never runs it, so the brain's own CLI
 * reports it from a masked, credential-free worker. Its answer is parsed as
 * untrusted data. An asset's type is its path's type under that
 * configuration, so the reported prefixes decide which assets are hidden. The
 * worker therefore sees only the policy's protected paths (#2699, option B):
 * a helper, local module or CLI script a governed turn could rewrite is
 * absent, so the taxonomy loads only from what no turn can change, or does
 * not load and every type refuses by name. A Markdown document declares its
 * type in frontmatter instead, so the host also reads the turn's immutable
 * view, data only, for documents of a translated type outside its folders.
 * Whatever the taxonomy claims, such a document refuses the turn.
 */
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { INDEX_DIR } from "@schlessera/brain-common/internal/index-location";
import type { WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";
import { protectedPaths } from "@schlessera/brain-common/internal/protected-paths";
import { brainCliCommand, taxonomyArgv } from "./client.js";
import type { EffectiveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { providerFolderRoots, providerMaskedFolders, providerTypeSelectors, translateProviderTypes, type ProviderTaxonomy } from "./governance-policy.js";
import { createPrivateIndexDirectory, removePrivateIndexDirectory, runMaskedBrainCli } from "./private-index.js";

/** How long admission waits for the taxonomy. */
export const PROVIDER_TAXONOMY_MS = 30_000;
const TAXONOMY_BYTES = 1024 * 1024;

/** The fields of `brain config check --json` a translation reads; the rest is ignored. */
const ConfigCheck = z.object({
  valid: z.literal(true),
  taxonomy: z.object({ types: z.record(z.string(), z.object({ prefixes: z.array(z.string()) })), inbox: z.string() }),
});

/** What `brain config check --json` reports for a configuration that does not load. */
const ConfigInvalid = z.object({ valid: z.literal(false), error: z.string() });

/**
 * Tier B names the taxonomy's own loading reads: the configuration, the
 * manifest and lockfile that resolve its imports, and the installed packages.
 */
const TAXONOMY_TIER_B = ["brain.config.ts", "brain.config.json", "package.json", "bun.lock", "node_modules"] as const;

/**
 * Whether a type-translated turn can establish that no governed turn could
 * have changed the code its taxonomy runs (#2699, option B). Everything the
 * taxonomy worker loads from the brain must be a protected path: it sees
 * nothing else. That cannot hold while the policy releases a tier B name the
 * load reads, or while the CLI it runs is a brain file outside the protected
 * paths, such as the `scripts/brain-cli.ts` fallback; both refuse here, by
 * name. Imports and local modules are settled by the worker itself, where an
 * unprotected file is simply absent. `.git` is never shown.
 */
export function taxonomyProtection(brainPath: string, policy: { protect?: readonly string[]; release?: readonly string[] },
  command?: readonly string[]): { ok: true; visible: string[] } | { ok: false; reason: string } {
  const released = TAXONOMY_TIER_B.filter(path => policy.release?.includes(path));
  if (released.length) return { ok: false, reason: `the governance policy releases ${released.join(", ")}, which the taxonomy loads, so a turn could change it` };
  const visible = protectedPaths(policy).filter(path => path !== ".git" && !path.startsWith(".git/"));
  const argv = command ?? brainCliCommand(brainPath);
  const files = argv.flatMap(arg => isAbsolute(arg) ? (arg.startsWith(`${brainPath}/`) ? [arg.slice(brainPath.length + 1)] : [])
    : /\.[cm]?[jt]sx?$/u.test(arg) ? [arg] : []);
  const unprotected = files.filter(file => !visible.some(path => file === path || file.startsWith(`${path}/`)));
  if (unprotected.length) return { ok: false, reason: `${command ? "" : "the brain has no packaged CLI (node_modules/.bin/brain), and "}the CLI it runs, ${unprotected.join(", ")}, is not a protected path` };
  return { ok: true, visible };
}

/**
 * Read the effective taxonomy in a worker that sees the brain through `folders`
 * masked and, with `visible`, sees only those paths of it.
 */
export async function readProviderTaxonomy(options: {
  brainPath: string; startupView: WorkerStartupView; folders: readonly string[]; index: string;
  maskPaths: readonly string[]; signal: AbortSignal; timeoutMs?: number; command?: readonly string[]; visible?: readonly string[];
}): Promise<{ ok: true; taxonomy: ProviderTaxonomy } | { ok: false; detail: string }> {
  const run = await runMaskedBrainCli({ ...options, timeoutMs: options.timeoutMs ?? PROVIDER_TAXONOMY_MS,
    command: taxonomyArgv(options.brainPath, options.command), label: "brain config check", outputBytes: TAXONOMY_BYTES });
  if (!run.ok) {
    // The CLI reports a configuration that does not load on stdout, such as an
    // import or a module it could not find; that names what to protect.
    let invalid: z.infer<typeof ConfigInvalid> | undefined;
    try { invalid = ConfigInvalid.parse(JSON.parse(run.stdout ?? "")); } catch { /* the exit detail stands */ }
    return { ok: false, detail: invalid ? invalid.error.split("\n")[0]!.slice(0, 500) : run.detail };
  }
  let parsed: z.infer<typeof ConfigCheck>;
  try { parsed = ConfigCheck.parse(JSON.parse(run.stdout)); }
  catch { return { ok: false, detail: "brain config check did not report a valid taxonomy" }; }
  return { ok: true, taxonomy: parsed.taxonomy };
}

/**
 * Markdown documents in `root` whose frontmatter declares one of `types`,
 * outside every masked folder. It looks wider than the index: hidden and
 * excluded directories, `node_modules` and uppercase `.MD` files count too,
 * since the turn can read them. It skips only `.git` and `.brain-index/`,
 * which the turn cannot see. A `.md` symbolic link is judged by the file it
 * resolves to, as the indexer reads it, unless that file lies in a masked
 * folder of the view or of the live brain at `brainPath`. A directory link
 * into the view or the live brain is checked where it leads; one leading out
 * of both is not followed and is reported without a type, as unverified. A
 * file whose frontmatter does not parse declares no type, as for the indexer.
 */
export function strayTypedDocuments(root: string, types: readonly string[], masked: readonly string[], brainPath = root): { path: string; type?: string }[] {
  const wanted = new Set(types), strays: { path: string; type?: string }[] = [];
  const skipped = new Set([".git", INDEX_DIR, ...masked]);
  const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  const bases = [real(root), real(brainPath)];
  const within = (target: string, folders: readonly string[]) => folders.some(folder => target === folder || target.startsWith(`${folder}/`));
  const hidden = bases.flatMap(base => masked.map(folder => join(base, folder)));
  // One nonblocking descriptor, checked before it is read: a peer may swap a
  // live link target for a FIFO, and reopening by name could then block.
  const declared = (file: string): unknown => {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) return undefined;
      // Frontmatter must open the file, so most files are settled by their head.
      const head = Buffer.alloc(8);
      if (!/^(\uFEFF)?---/u.test(head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString("utf8"))) return undefined;
      try { return parseFrontmatter(readFileSync(fd, "utf8"), { dataOnly: true }).data?.type; } catch { return undefined; }
    } finally { closeSync(fd); }
  };
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!skipped.has(path)) walk(path); continue; }
      let file = join(root, path);
      if (entry.isSymbolicLink()) {
        let target: string;
        try { target = realpathSync(file); } catch { continue; }
        if (within(target, hidden)) continue;
        if (statSync(target).isDirectory()) { if (!within(target, bases)) strays.push({ path }); continue; }
        file = target;
      } else if (!entry.isFile()) continue;
      if (!/\.md$/iu.test(entry.name)) continue;
      const type = declared(file);
      if (type !== undefined && type !== null && wanted.has(String(type))) strays.push({ path, type: String(type) });
    }
  };
  walk("");
  return strays.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Translate a policy's type selectors on one immutable view, as every turn
 * admission does (hosted and autonomous, #2694, #2691). The taxonomy worker
 * sees only the protected paths, with the literal folders masked, so it
 * writes into a throwaway directory, never a turn's private index. Without
 * established protection every type refuses, naming why (#2699). A type maps
 * only if no Markdown document of it lies outside the folders it would mask.
 */
export async function translateProviderTypesInView(options: {
  brainPath: string; policy: Pick<EffectiveGovernancePolicy, "providers" | "protect" | "release">; view: WorkerStartupView;
  maskPaths: readonly string[]; signal: AbortSignal; command?: readonly string[];
}): Promise<{ folders: Record<string, string[]>; refused: string[] }> {
  const types = providerTypeSelectors(options.policy);
  const protection = taxonomyProtection(options.brainPath, options.policy, options.command);
  if (!protection.ok) return { folders: {}, refused: types.map(type => `type ${type} (the brain's taxonomy is not protected: ${protection.reason})`) };
  const scratch = createPrivateIndexDirectory();
  let read: Awaited<ReturnType<typeof readProviderTaxonomy>>;
  try {
    read = await readProviderTaxonomy({ brainPath: options.brainPath, startupView: options.view, folders: providerFolderRoots(options.policy), index: scratch,
      maskPaths: options.maskPaths, signal: options.signal, visible: protection.visible, ...(options.command ? { command: options.command } : {}) });
  } finally { removePrivateIndexDirectory(scratch); }
  options.signal.throwIfAborted();
  if (!read.ok) return { folders: {}, refused: types.map(type => `type ${type} (the brain's taxonomy could not be read from its protected paths alone: ${read.detail}; `
    + "protect every file the configuration, its modules and its CLI load, with the governance policy's protect list)") };
  const translated = translateProviderTypes(types, read.taxonomy);
  const strays = strayTypedDocuments(options.view.root, Object.keys(translated.folders), providerMaskedFolders(options.policy, translated.folders), options.brainPath);
  const listed = (paths: string[]) => `${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` and ${paths.length - 3} more` : ""}`;
  const unverified = strays.filter(stray => stray.type === undefined).map(stray => stray.path);
  for (const [type, folders] of Object.entries(translated.folders)) {
    const paths = strays.filter(stray => stray.type === type).map(stray => stray.path);
    if (paths.length) translated.refused.push(`type ${type} (${listed(paths)} ${paths.length === 1 ? "declares" : "declare"} it outside ${folders.join(", ")})`);
    if (unverified.length) translated.refused.push(`type ${type} (${listed(unverified)} ${unverified.length === 1 ? "links" : "link"} to a folder outside the brain, which cannot be checked)`);
  }
  return translated;
}
