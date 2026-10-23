/**
 * Host-side refusal of provider-masked paths (#1668, #2690). A turn whose
 * worker masks provider folders must not read or write them through a host
 * bridge tool either: those tools run on the server, outside the worker's
 * mounts, against the real brain.
 */
import type { EffectiveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { providerFolderRoots } from "./governance-policy.js";

/** The named refusal code an application result, or a thrown read, carries. */
export const PROVIDER_MASKED = "provider_masked";

export interface ProviderMaskRefusal {
  /** The agent-facing tool name, as the governance event records it. */
  tool: string;
  path: string;
  /** The `providers` rule whose selector (a folder path, or `type <name>`) maps onto the masked folder. */
  rule: { list: "providers"; index: number; pattern: string };
}

export class ProviderMaskRefusedError extends Error {
  readonly code = PROVIDER_MASKED;
  constructor(readonly refusal: ProviderMaskRefusal) {
    super(`${PROVIDER_MASKED}: ${refusal.path} is hidden from this turn by the governance policy's provider rule `
      + `\`${refusal.rule.pattern}\`; nothing was read or written. Work with paths outside the masked folders.`);
    this.name = "ProviderMaskRefusedError";
  }
}

/**
 * A host read of the server's own records, refused whole while the turn has
 * masked folders (#2698, option A). The activity record and inbox items keep
 * free text from earlier runs, which may quote a masked document; no field
 * says which, so nothing is filtered and nothing is read.
 */
export class ProviderRecordsRefusedError extends Error {
  readonly code = PROVIDER_MASKED;
  constructor(readonly tool: string, folders: readonly string[], what: string) {
    super(`${PROVIDER_MASKED}: ${tool} is unavailable to this turn, because the governance policy's provider rules hide `
      + `${folders.map(folder => `\`${folder}/\``).join(", ")} from it. ${what} keeps text from earlier runs, which may quote those folders; nothing was read. `
      + "The user can still read it in the app.");
    this.name = "ProviderRecordsRefusedError";
  }
}

export interface ProviderMaskGuard {
  /** The admitted turn's masked roots, as its worker mounts them. */
  readonly folders: readonly string[];
  /**
   * Refuse when any path is at or below a masked root, recording one
   * governance event for the call. Nothing is read before this check.
   */
  assert(tool: string, paths: readonly string[]): void;
}

/**
 * The lexical form a host route resolves a repository-relative path to.
 * Routes refuse `..`, `.` and empty segments themselves; the mask check
 * still resolves them, so no spelling reaches a masked root unrefused.
 */
function segments(path: string): string[] {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop(); else out.push(part);
  }
  return out;
}

/** Whether a repository-relative path is at or below one of the masked roots. */
export function isProviderMasked(path: string, folders: readonly string[]): boolean {
  const parts = segments(path);
  return folders.some(folder => {
    const root = segments(folder);
    return root.length > 0 && root.length <= parts.length && root.every((part, i) => parts[i] === part);
  });
}

/**
 * Masked roots are matched case-sensitively, by whole segments. Aliases are
 * refused by the routes themselves: each opens its directory chain with
 * `O_NOFOLLOW` and accepts only a regular file with one link.
 */
export function createProviderMaskGuard(options: {
  folders: readonly string[];
  policy: Pick<EffectiveGovernancePolicy, "providers">;
  /** The folders admission translated each selected type to (#2694). */
  typeFolders?: Readonly<Record<string, readonly string[]>>;
  record(refusal: ProviderMaskRefusal): void;
}): ProviderMaskGuard {
  const folders = Object.freeze([...options.folders]);
  const providers = options.policy.providers;
  // The first rule that maps onto the folder: a path selector naming it whole,
  // else a type admission translated onto it.
  const ruleFor = (root: string) => {
    for (const [index, rule] of providers.entries()) {
      const pattern = rule.paths.find(path => providerFolderRoots({ providers: [{ paths: [path], allow: [] }] }).includes(root));
      if (pattern) return { index, pattern };
    }
    for (const [index, rule] of providers.entries()) {
      const type = (rule.types ?? []).find(name => options.typeFolders?.[name]?.includes(root));
      if (type) return { index, pattern: `type ${type}` };
    }
    return { index: 0, pattern: `${root}/**` };
  };
  const rules = folders.map(root => ({ root, rule: Object.freeze({ list: "providers" as const, ...ruleFor(root) }) }));
  const match = (path: string) => rules.find(({ root }) => isProviderMasked(path, [root]));
  return {
    folders,
    assert(tool, paths) {
      for (const path of paths) {
        const hit = match(path);
        if (!hit) continue;
        const refusal = { tool, path, rule: hit.rule };
        options.record(refusal);
        throw new ProviderMaskRefusedError(refusal);
      }
    },
  };
}
