/** A low-level safety net for isolated guard probes, including mutations. */
import { basename } from "node:path";

export const nativeCalls: string[] = [];
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    nativeCalls.push(`fetch ${url.href}`);
    throw new Error(`NATIVE_FETCH_SENTINEL ${url.href}`);
  }
  // Even a disabled redirect guard cannot dispatch externally from this probe.
  if (init?.redirect !== "manual" && (input instanceof Request ? input.redirect : init?.redirect) !== "manual") {
    nativeCalls.push(`automatic redirect ${url.href}`);
    throw new Error("NATIVE_REDIRECT_SENTINEL");
  }
  return nativeFetch(input, init);
}, nativeFetch);

for (const key of ["spawn", "spawnSync"] as const) {
  const native = Bun[key];
  Bun[key] = ((command: string[] | { cmd: string[] }, options?: unknown) => {
    const cmd = Array.isArray(command) ? command : command.cmd;
    if (basename(cmd[0]!) === "curl") {
      nativeCalls.push(`${key} ${cmd.join(" ")}`);
      throw new Error("NATIVE_CURL_SENTINEL");
    }
    return Reflect.apply(native, Bun, options === undefined ? [command] : [command, options]);
  }) as typeof Bun.spawn & typeof Bun.spawnSync;
}

process.on("exit", () => console.log(`NATIVE_CALLS=${JSON.stringify(nativeCalls)}`));
try {
  const { afterAll } = await import("bun:test");
  afterAll(() => console.log(`NATIVE_CALLS=${JSON.stringify(nativeCalls)}`));
} catch {
  // Ordinary child scripts use the exit listener instead of test hooks.
}
