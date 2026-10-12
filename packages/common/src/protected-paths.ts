/**
 * The protected paths of a `governed` brain (docs/decisions/governed-writable-workers.md,
 * "Protected paths"). A write to one of them would let a turn change its own
 * rules, or run start-up code or grant permissions in a later turn or on the
 * host. The governed profile mounts the existing ones read-only; the host
 * execution boundary records which ones exist before a governed turn starts and
 * quarantines any that appear during it (#1648).
 *
 * One list, read by every consumer, so the mounts, the durable manifest and the
 * quarantine cannot disagree about what is protected.
 */

/** Tier A: governance, secrets and start-up code. The policy can never release these. */
export const PROTECTED_TIER_A = [
  "context/policies",
  ".git/config",
  ".git/config.worktree",
  ".git/hooks",
  ".git/info",
  ".git/modules",
  "bunfig.toml",
] as const;

/** Tier B: runtime permission and configuration surfaces. Protected by default; the policy may release them. */
export const PROTECTED_TIER_B = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".mcp.json",
  "brain.config.ts",
  "brain.config.json",
  "package.json",
  "bun.lock",
  "node_modules",
] as const;

/**
 * Tier A by prefix: every brain-root name starting with `.env` (`.env`,
 * `.env.local`, `.env.production`, …). Secrets, and Bun loads them into every
 * process started with the brain as its working directory.
 */
export const PROTECTED_ENV_PREFIX = ".env";

/** Whether a brain-relative path is one of the `.env*` names. */
export function isEnvName(path: string): boolean {
  return !path.includes("/") && path.startsWith(PROTECTED_ENV_PREFIX);
}

/**
 * The protected brain-relative paths of one brain: the built-in tiers, minus
 * what the policy releases (tier B only), plus what it adds. `.env*` names are
 * matched by prefix and are not in this list; see {@link isEnvName}.
 */
export function protectedPaths(policy: { protect?: readonly string[]; release?: readonly string[] } = {}): string[] {
  const release = new Set(policy.release ?? []);
  const paths = new Set<string>([...PROTECTED_TIER_A, ...PROTECTED_TIER_B.filter(path => !release.has(path))]);
  for (const path of policy.protect ?? []) paths.add(path);
  return [...paths];
}
