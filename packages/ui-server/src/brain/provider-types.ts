/**
 * Translating a provider rule's document types into folder masks (#2694,
 * option C). A type maps onto folders only through the brain's taxonomy, which
 * lives in `brain.config.ts`: the host never runs it, so the brain's own CLI
 * reports it from a masked, credential-free worker. Its answer is parsed as
 * untrusted data. The configuration itself is protected (tier B), and an
 * asset's type is its path's type under that configuration, so the reported
 * prefixes decide which assets are hidden. A Markdown document declares its
 * type in frontmatter instead, so the host also reads the turn's immutable
 * view, data only, for documents of a translated type outside its folders.
 * Whatever the taxonomy claims, such a document refuses the turn.
 */
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseFrontmatter } from "@schlessera/brain-common/internal/frontmatter";
import { INDEX_DIR } from "@schlessera/brain-common/internal/index-location";
import type { WorkerStartupView } from "@schlessera/brain-ui-sdk/internal";
import { taxonomyArgv } from "./client.js";
import type { ProviderTaxonomy } from "./governance-policy.js";
import { runMaskedBrainCli } from "./private-index.js";

/** How long admission waits for the taxonomy. */
export const PROVIDER_TAXONOMY_MS = 30_000;
const TAXONOMY_BYTES = 1024 * 1024;

/** The fields of `brain config check --json` a translation reads; the rest is ignored. */
const ConfigCheck = z.object({
  valid: z.literal(true),
  taxonomy: z.object({ types: z.record(z.string(), z.object({ prefixes: z.array(z.string()) })), inbox: z.string() }),
});

/** Read the effective taxonomy in a worker that sees the brain through `folders` masked. */
export async function readProviderTaxonomy(options: {
  brainPath: string; startupView: WorkerStartupView; folders: readonly string[]; index: string;
  maskPaths: readonly string[]; signal: AbortSignal; timeoutMs?: number; command?: readonly string[];
}): Promise<{ ok: true; taxonomy: ProviderTaxonomy } | { ok: false; detail: string }> {
  const run = await runMaskedBrainCli({ ...options, timeoutMs: options.timeoutMs ?? PROVIDER_TAXONOMY_MS,
    command: taxonomyArgv(options.brainPath, options.command), label: "brain config check", outputBytes: TAXONOMY_BYTES });
  if (!run.ok) return run;
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
