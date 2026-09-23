/**
 * Which Claude Code binary the Claude runner spawns (#213): the one chat runs.
 *
 * The chat backend runs the Agent SDK's built-in binary unless
 * `CLAUDE_CODE_PATH` names another (docs/decisions/claude-code-runtime.md,
 * "The decision"). The runner resolves the same way, so `brain sync` does not
 * depend on a host install of `claude`:
 *
 * 1. `CLAUDE_CODE_PATH`, when set — the host's deliberate override. A
 *    JavaScript path runs through `bun` (or `node`), as the SDK runs it.
 * 2. The SDK's built-in binary, found the way the SDK finds it: its platform
 *    package, resolved from the SDK's own module. On Linux the glibc package
 *    comes first and the musl one second, reversed when the runtime reports
 *    no glibc; the first that exists wins.
 * 3. `claude` on `PATH`, when the SDK is not installed alongside this package.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import { resolveEnv } from "../../config/env.js";

const SDK = "@anthropic-ai/claude-agent-sdk";

export interface ClaudeBinaryPlatform {
  platform: NodeJS.Platform;
  arch: string;
  /** True when the runtime reports no glibc, so musl is tried first. */
  preferMusl: boolean;
}

/**
 * The SDK's own libc probe: only on Linux, and only a report that exists and
 * names no glibc means musl. No report at all keeps glibc first.
 */
export function prefersMusl(
  platform: NodeJS.Platform,
  /** The runtime's report function; null when it has none. */
  getReport: (() => unknown) | null = process.report?.getReport?.bind(process.report) ?? null
): boolean {
  if (platform !== "linux") return false;
  const report = typeof getReport === "function" ? (getReport() as { header?: { glibcVersionRuntime?: string } } | null) : null;
  return report != null && report.header?.glibcVersionRuntime === undefined;
}

/** The platform packages the SDK would look in, in its order. */
export function bundledClaudeCandidates(target: ClaudeBinaryPlatform): string[] {
  const exe = target.platform === "win32" ? ".exe" : "";
  const packages =
    target.platform === "android"
      ? [`${SDK}-linux-${target.arch}-android`]
      : target.platform === "linux"
        ? target.preferMusl
          ? [`${SDK}-linux-${target.arch}-musl`, `${SDK}-linux-${target.arch}`]
          : [`${SDK}-linux-${target.arch}`, `${SDK}-linux-${target.arch}-musl`]
        : [`${SDK}-${target.platform}-${target.arch}`];
  return packages.map((name) => `${name}/claude${exe}`);
}

/**
 * The SDK's built-in binary as seen from `from` (a module path), or null when
 * the SDK or its platform package is not installed there. Never throws: an
 * optional dependency that cannot be found is the PATH fallback, not an error.
 */
export function bundledClaudeBinary(
  from: string = import.meta.url,
  target?: ClaudeBinaryPlatform
): string | null {
  try {
    const sdkEntry = createRequire(from).resolve(SDK);
    const fromSdk = createRequire(sdkEntry);
    const platform = target ?? {
      platform: process.platform,
      arch: process.arch,
      preferMusl: prefersMusl(process.platform),
    };
    for (const candidate of bundledClaudeCandidates(platform)) {
      try {
        const path = fromSdk.resolve(candidate);
        if (existsSync(path)) return path;
      } catch {
        // not installed; try the next
      }
    }
  } catch {
    // no SDK here, or no way to tell the platform
  }
  return null;
}

/** The extensions the SDK runs through an interpreter rather than directly. */
const SCRIPT_EXTENSIONS = [".js", ".mjs", ".tsx", ".ts", ".jsx"];

/**
 * The argv prefix the Claude runner spawns: the binary, or for a JavaScript
 * `CLAUDE_CODE_PATH` the interpreter the SDK would use (`bun` under Bun,
 * `node` otherwise) followed by the script, as chat runs it.
 */
export function claudeCommand(env?: NodeJS.ProcessEnv, from?: string): string[] {
  const configured = resolveEnv(env).claudeCodePath;
  if (configured && SCRIPT_EXTENSIONS.some((ext) => configured.endsWith(ext))) {
    return [process.versions.bun !== undefined ? "bun" : "node", configured];
  }
  return [configured ?? bundledClaudeBinary(from) ?? "claude"];
}
