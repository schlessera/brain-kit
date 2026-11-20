/** Test-only fail-closed admission for the installed native Claude runtime. */
import childProcess from "node:child_process";
import { basename } from "node:path";

/** Match native executables and the SDK's JavaScript CLI entry point. */
export function isNativeClaude(command: string, args: readonly unknown[] = []): boolean {
  return /^(claude|claude-code)(\.exe)?$/.test(basename(command)) ||
    args.some(value => typeof value === "string" && /claude-agent-sdk[^\n]*\/cli\.(js|mjs)$/.test(value));
}

export function refuseNativeClaude(command: string, args: readonly unknown[] = []): void {
  if (!isNativeClaude(command, args)) return;
  // Never include arguments, environment, settings, paths or provider output.
  const receipt = { kind: "native-offline-boundary", success: false, nativeLaunched: false,
    reason: "OS isolation has not been qualified" };
  console.error(JSON.stringify(receipt));
  throw new Error("Offline native Claude refused before launch: OS isolation has not been qualified");
}

export function installNativeClaudeGuard(): void {
  for (const key of ["spawn", "spawnSync", "execFile", "execFileSync"] as const) {
    const original = childProcess[key];
    Object.defineProperty(childProcess, key, { configurable: true, writable: true,
      value: (...args: unknown[]) => {
        refuseNativeClaude(String(args[0]), Array.isArray(args[1]) ? args[1] : []);
        return Reflect.apply(original, childProcess, args);
      } });
  }
}
