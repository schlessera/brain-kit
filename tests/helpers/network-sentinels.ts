/** A low-level safety net for isolated guard probes, including mutations. */
import { basename } from "node:path";
import { isIP, Socket } from "node:net";

export const nativeCalls: string[] = [];
const local = (host: string) => host === "localhost" || host === "::1" || isIP(host) === 4 && host.startsWith("127.");
const nativeConnect = Socket.prototype.connect;
Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
  // Bun's net/tls factories pass their normalized arguments as one array.
  const values = Array.isArray(args[0]) ? args[0] : args;
  const first = values[0];
  const options = typeof first === "object" && first !== null ? first
    : typeof first === "string" && Number.isNaN(Number(first)) ? { path: first }
    : { port: first, host: typeof values[1] === "string" ? values[1] : "localhost" };
  const { host = "localhost", port, path, socket, fd } = options;
  if (!path && !socket && fd == null && !local(host)) {
    nativeCalls.push(`socket.connect ${host}:${port}`);
    // The failing-first TCP probe really connects, but only to its owned
    // loopback listener. Losing the guard can never contact an external host.
    if (process.env.PROBE_SOCKET_PORT) return Reflect.apply(nativeConnect, this,
      [{ ...options, host: "127.0.0.1", port: Number(process.env.PROBE_SOCKET_PORT) }, values.findLast(value => typeof value === "function")]);
    throw new Error(`NATIVE_SOCKET_SENTINEL ${host}`);
  }
  return Reflect.apply(nativeConnect, this, args);
} as typeof Socket.prototype.connect;
const nativeBunConnect = Bun.connect;
Bun.connect = ((options: Bun.TCPSocketConnectOptions<unknown> | Bun.UnixSocketOptions<unknown>) => {
  if ("hostname" in options && !local(options.hostname)) {
    nativeCalls.push(`Bun.connect ${options.hostname}:${options.port}`);
    throw new Error(`NATIVE_SOCKET_SENTINEL ${options.hostname}`);
  }
  return "hostname" in options ? nativeBunConnect(options) : nativeBunConnect(options);
}) as typeof Bun.connect;
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
