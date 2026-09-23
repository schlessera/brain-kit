/**
 * Which Claude Code binary the Claude runner spawns (#213): the one chat runs.
 *
 * The chat backend runs the Agent SDK's built-in binary unless
 * `CLAUDE_CODE_PATH` names another (docs/decisions/claude-code-runtime.md,
 * "The decision"). The runner resolves the same way, so `brain sync` does not
 * depend on a host install of `claude`:
 *
 * 1. `CLAUDE_CODE_PATH`, when set — the host's deliberate override.
 * 2. The SDK's built-in binary, found the way the SDK finds it: its platform
 *    package, resolved from the SDK's own module. On Linux the glibc package
 *    comes first and the musl one second, reversed when the runtime reports
 *    no glibc; the first that exists wins.
 * 3. `claude` on `PATH`, when the SDK is not installed alongside this package.
 */
import { createRequire } from "node:module";

import { resolveEnv } from "../../config/env.js";

const SDK = "@anthropic-ai/claude-agent-sdk";

export interface ClaudeBinaryPlatform {
  platform: NodeJS.Platform;
  arch: string;
  /** True when the runtime reports no glibc, so musl is tried first. */
  preferMusl: boolean;
}

function currentPlatform(): ClaudeBinaryPlatform {
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return {
    platform: process.platform,
    arch: process.arch,
    preferMusl: process.platform === "linux" && report?.header?.glibcVersionRuntime === undefined,
  };
}

/** The platform packages the SDK would look in, in its order. */
export function bundledClaudeCandidates(target: ClaudeBinaryPlatform): string[] {
  const exe = target.platform === "win32" ? ".exe" : "";
  const base = `${SDK}-${target.platform}-${target.arch}`;
  const packages =
    target.platform === "linux"
      ? target.preferMusl
        ? [`${base}-musl`, base]
        : [base, `${base}-musl`]
      : [base];
  return packages.map((name) => `${name}/claude${exe}`);
}

/**
 * The SDK's built-in binary as seen from `from` (a module path), or null when
 * the SDK or its platform package is not installed there.
 */
export function bundledClaudeBinary(
  from: string = import.meta.url,
  target: ClaudeBinaryPlatform = currentPlatform()
): string | null {
  let sdkEntry: string;
  try {
    sdkEntry = createRequire(from).resolve(SDK);
  } catch {
    return null;
  }
  const fromSdk = createRequire(sdkEntry);
  for (const candidate of bundledClaudeCandidates(target)) {
    try {
      return fromSdk.resolve(candidate);
    } catch {
      // not installed; try the next
    }
  }
  return null;
}

/** The command the Claude runner spawns. */
export function claudeExecutable(env?: NodeJS.ProcessEnv): string {
  return resolveEnv(env).claudeCodePath ?? bundledClaudeBinary() ?? "claude";
}
