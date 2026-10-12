/** Read-only, data-only governance policy input. Enforcement belongs to its owning siblings. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseFrontmatter } from "./frontmatter-parse.js";
import { PROTECTED_TIER_B } from "./protected-paths.js";

export const GOVERNANCE_POLICY_PATH = "context/policies/governance.md";
/** Bound the data-only host read, including the ignored prose body. */
export const GOVERNANCE_POLICY_MAX_BYTES = 1024 * 1024;
const amount = z.number().finite().nonnegative();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1);
const strings = z.array(text);
const relativePath = text.refine(value => !value.startsWith("/") && !value.startsWith("~") && !/^[A-Za-z]:/.test(value) && !value.includes("\\")
  && !/[\u0000-\u001f\u007f]/u.test(value) && value.split("/").every(part => part !== "" && part !== "." && part !== ".."),
  "Use a canonical brain-relative path without empty, dot or parent segments");
const budget = z.strictObject({ warn_usd: amount.optional(), block_usd: amount.optional(),
  warn_tokens: count.optional(), block_tokens: count.optional() });
const command = z.strictObject({ pattern: text, reason: z.string().optional() });
/** Anchored policy sources use the existing case-insensitive regex compiler semantics. */
const commands = z.array(command).transform((entries, ctx) => {
  const valid = entries.filter(entry => { try { new RegExp(entry.pattern, "i"); return true; } catch { return false; } });
  if (entries.length && !valid.length) ctx.addIssue({ code: "custom", message: "Nonempty command list contains no valid regular expression; repair it or explicitly use []" });
  return valid;
});

export const GovernancePolicySchema = z.strictObject({
  schema_version: z.literal(1),
  profiles: z.strictObject({ interactive: z.enum(["governed", "strict"]).optional(), voice: z.enum(["governed", "strict"]).optional() }).optional(),
  protect: z.array(relativePath).optional(),
  release: z.array(relativePath.refine(path => (PROTECTED_TIER_B as readonly string[]).includes(path), "Only exact built-in tier B paths can be released")).optional(),
  budgets: z.strictObject({ turn: budget.optional(), session: budget.optional(), day: budget.optional() }).optional(),
  scope: z.strictObject({ max_files_changed: count.optional(), max_minutes: amount.optional(), max_tool_calls: count.optional(), max_bytes_written: count.optional() }).optional(),
  commands: z.strictObject({ deny: commands.optional(), confirm: commands.optional() }).optional(),
  egress: z.strictObject({ mode: z.enum(["record", "allowlist"]).optional(), allow: strings.optional(), deny: strings.optional(), max_bytes_per_turn: count.optional() }).optional(),
  outward: z.strictObject({ allow: z.array(z.strictObject({ command: text, remotes: strings })).optional(), hosts: strings.optional() }).optional(),
  taint: z.strictObject({ egress: z.strictObject({ allow: strings }).optional() }).optional(),
  providers: z.array(z.strictObject({ paths: strings, allow: strings })).optional(),
});
export type GovernancePolicyInput = z.infer<typeof GovernancePolicySchema>;

/** Approved 2026-10-12 defaults; file/byte scope caps are explicitly provisional. */
export const BUILTIN_GOVERNANCE_POLICY = {
  schema_version: 1 as const,
  profiles: { interactive: "governed" as const, voice: "governed" as const },
  protect: [] as string[], release: [] as string[],
  budgets: {
    turn: { warn_usd: 100, block_usd: 200, block_tokens: 512_000_000 },
    session: { warn_usd: 2_000, block_usd: 4_000, block_tokens: 8_000_000_000 },
    day: { warn_usd: 2_000, block_usd: 4_000, block_tokens: 8_000_000_000 },
  },
  scope: { max_files_changed: 1_000, max_minutes: 120, max_tool_calls: 500, max_bytes_written: 4 * 1024 ** 3 },
  commands: { deny: [] as Array<{ pattern: string; reason?: string }>, confirm: [] as Array<{ pattern: string; reason?: string }> },
  egress: { mode: "record" as "record" | "allowlist", allow: [] as string[], deny: [] as string[] },
  outward: { allow: [] as Array<{ command: string; remotes: string[] }>, hosts: [] as string[] },
  taint: { egress: { allow: [] as string[] } }, providers: [] as Array<{ paths: string[]; allow: string[] }>,
};

export function resolveGovernancePolicy(policy: GovernancePolicyInput) {
  const defaults = structuredClone(BUILTIN_GOVERNANCE_POLICY);
  return { ...defaults, ...policy,
    profiles: { ...defaults.profiles, ...policy.profiles },
    budgets: { turn: { ...defaults.budgets.turn, ...policy.budgets?.turn }, session: { ...defaults.budgets.session, ...policy.budgets?.session }, day: { ...defaults.budgets.day, ...policy.budgets?.day } },
    scope: { ...defaults.scope, ...policy.scope }, commands: { ...defaults.commands, ...policy.commands },
    egress: { ...defaults.egress, ...policy.egress }, outward: { ...defaults.outward, ...policy.outward },
    taint: { egress: { ...defaults.taint.egress, ...policy.taint?.egress } },
  };
}
export type EffectiveGovernancePolicy = ReturnType<typeof resolveGovernancePolicy>;
export interface GovernancePolicyCheck {
  schema_version: 1; ok: boolean; status: "valid" | "invalid" | "missing";
  content_hash: string | null; errors: string[]; warnings: string[]; effective: EffectiveGovernancePolicy;
}

/** SHA-256 of exact UTF-8 file bytes, including ignored body, identifies the version read. */
export function parseGovernancePolicy(bytes: Uint8Array): GovernancePolicyCheck {
  const content_hash = createHash("sha256").update(bytes).digest("hex");
  try {
    if (bytes.byteLength > GOVERNANCE_POLICY_MAX_BYTES) throw new Error("Policy exceeds the 1 MiB input bound");
    const input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const data = parseFrontmatter(input).data;
    const warnings: string[] = [];
    for (const list of ["deny", "confirm"] as const) {
      const entries = data?.commands?.[list];
      if (Array.isArray(entries)) for (const [index, entry] of entries.entries()) {
        if (typeof entry?.pattern !== "string") continue; // Structural schema reports this as an error.
        try { new RegExp(entry.pattern, "i"); }
        catch (error) { warnings.push(`commands.${list}[${index}]: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    const parsed = GovernancePolicySchema.safeParse(data);
    if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
    return { schema_version: 1, ok: true, status: "valid", content_hash, errors: [], warnings, effective: resolveGovernancePolicy(parsed.data) };
  } catch (error) {
    return { schema_version: 1, ok: false, status: "invalid", content_hash, errors: [error instanceof Error ? error.message : String(error)], warnings: [], effective: resolveGovernancePolicy({ schema_version: 1 }) };
  }
}

/** Descriptor-anchored, no links or FIFO reads; never loads brain configuration or executes code. */
export function checkGovernancePolicy(brainPath: string): GovernancePolicyCheck {
  const fds: number[] = [];
  const directories: Array<{ path: string; fd: number }> = [];
  try {
    let path = realpathSync(brainPath);
    let fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); fds.push(fd);
    directories.push({ path, fd });
    const parts = GOVERNANCE_POLICY_PATH.split("/");
    for (const part of parts.slice(0, -1)) {
      path = join(path, part);
      fd = openSync(process.platform === "linux" ? `/proc/self/fd/${fd}/${part}` : path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); fds.push(fd);
      directories.push({ path, fd });
    }
    fd = openSync(process.platform === "linux" ? `/proc/self/fd/${fd}/${parts.at(-1)!}` : join(path, parts.at(-1)!),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); fds.push(fd);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Error("Policy must be a regular file without hardlink aliases");
    if (info.size > GOVERNANCE_POLICY_MAX_BYTES) throw new Error("Policy exceeds the 1 MiB input bound");
    const bytes = Buffer.alloc(GOVERNANCE_POLICY_MAX_BYTES + 1); let length = 0;
    while (length < bytes.length) { const read = readSync(fd, bytes, length, bytes.length - length, null); if (!read) break; length += read; }
    const after = fstatSync(fd);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || length !== info.size) throw new Error("Policy changed while it was read; retry the check or repair the edit");
    // Non-Linux CLI readers cannot use /proc descriptor traversal. They open
    // each component without following links and reject changed ancestry.
    // Hosted workers require Linux, where every open above is descriptor-relative.
    if (process.platform !== "linux") for (const directory of directories) {
      const named = lstatSync(directory.path), held = fstatSync(directory.fd);
      if (!named.isDirectory() || named.dev !== held.dev || named.ino !== held.ino) throw new Error("Policy ancestry changed while it was read");
    }
    return parseGovernancePolicy(bytes.subarray(0, length));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { schema_version: 1, ok: missing, status: missing ? "missing" : "invalid", content_hash: null,
      errors: missing ? [] : [error instanceof Error ? error.message : String(error)], warnings: [], effective: resolveGovernancePolicy({ schema_version: 1 }) };
  } finally { for (const fd of fds.reverse()) closeSync(fd); }
}
