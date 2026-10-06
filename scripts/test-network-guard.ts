/** Test-only transport safeguard; never imported by a published package. */
import { basename, join } from "node:path";

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
let installed: { assertNoEscapes(): void } | undefined;

/**
 * Bun before 1.4.0 closes a subprocess's extra stdio pipes (`stdio[3]` and up)
 * a second time when the Subprocess is garbage-collected (oven-sh/bun#33828).
 * `node:child_process` hands the same fd to a `net.Socket`, which already
 * closed it when the child exited, so the kernel may have given that number
 * to a newer fd. Playwright launches Chrome this way (`--remote-debugging-pipe`
 * on fds 3 and 4), and a later collection in the same test process then closed
 * the pidfd and output pipes of an unrelated Bun.spawn child: its exit and
 * output were never observed, and the test hung (#1043). Keeping those
 * Subprocess objects reachable means the finalizer never runs. The cost is one
 * small object per such spawn, plus, for a direct Bun.spawn caller that never
 * takes and closes `stdio[N]`, that fd staying open until the process exits.
 */
const STALE_EXTRA_STDIO_CLOSE = Bun.semver.order(Bun.version, "1.4.0") < 0;
const retainedSubprocesses: unknown[] = [];

function retainExtraStdio(subprocess: unknown, options: unknown): void {
  if (!STALE_EXTRA_STDIO_CLOSE) return;
  const stdio = (options as { stdio?: unknown } | undefined)?.stdio;
  if (Array.isArray(stdio) && stdio.slice(3).includes("pipe")) retainedSubprocesses.push(subprocess);
}

export function installNetworkGuard(): { assertNoEscapes(): void } {
  if (installed) return installed;
  const escapes: string[] = [];
  let reported = 0;
  const message = () => `Offline test guard: attempted real network access\n${escapes.join("\n")}`;
  function refuse(detail: string): never {
    escapes.push(detail);
    throw new Error(message());
  }
  function permitted(url: URL): void {
    if (!["http:", "https:"].includes(url.protocol) || !LOOPBACK.has(url.hostname)) {
      refuse(`fetch ${url.href}`);
    }
  }

  const nativeFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async function offlineFetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
    let request = new Request(input, init);
    permitted(new URL(request.url));
    // A loopback destination routed through an external proxy is not local.
    if ((init as RequestInit & { proxy?: unknown } | undefined)?.proxy) refuse(`fetch proxy for ${request.url}`);
    const mode = request.redirect;
    for (let hop = 0; ; hop++) {
      const replay = request.clone();
      const response = await nativeFetch(request, { redirect: "manual" });
      const location = REDIRECTS.has(response.status) ? response.headers.get("location") : null;
      if (mode === "manual" || location === null) {
        if (hop) Object.defineProperty(response, "redirected", { value: true });
        return response;
      }
      await response.body?.cancel();
      if (mode === "error") throw new TypeError("Fetch redirect mode is error");
      if (hop === 20) throw new TypeError("Fetch redirected more than 20 times");
      const next = new URL(location, request.url);
      permitted(next);
      const headers = new Headers(request.headers);
      if (next.origin !== new URL(request.url).origin) {
        for (const name of ["authorization", "cookie", "proxy-authorization"]) headers.delete(name);
      }
      const rewrite = (response.status === 303 && request.method !== "HEAD") ||
        ([301, 302].includes(response.status) && request.method === "POST");
      if (rewrite) {
        for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) headers.delete(name);
      }
      request = new Request(next, {
        method: rewrite ? "GET" : replay.method,
        headers,
        body: rewrite ? undefined : replay.body,
        signal: replay.signal,
        credentials: replay.credentials,
        redirect: mode,
      });
    }
  }, nativeFetch);

  const childPreload = join(import.meta.dir, "test-network-child-preload.ts");
  for (const key of ["spawn", "spawnSync"] as const) {
    const native = Bun[key];
    Bun[key] = ((...args: unknown[]) => {
      const first = args[0] as string[] | { cmd: string[] };
      const cmd = Array.isArray(first) ? first : first.cmd;
      const executable = String(cmd[0]);
      if (basename(executable) === "curl") refuse(`${key} ${cmd.join(" ")}`);
      if (basename(executable) === "bun" || executable === process.execPath) {
        // Bun treats `bun --preload FILE test` as a package script. Keep the
        // builtin/subcommand first so child tests remain child tests.
        const index = ["test", "run"].includes(cmd[1] ?? "") ? 2 : 1;
        const guarded = [...cmd.slice(0, index), "--preload", childPreload, ...cmd.slice(index)];
        args[0] = Array.isArray(first) ? guarded : { ...first, cmd: guarded };
      }
      const result = Reflect.apply(native, Bun, args);
      if (key === "spawn") retainExtraStdio(result, Array.isArray(first) ? args[1] : first);
      return result;
    }) as typeof Bun.spawn & typeof Bun.spawnSync;
  }

  installed = {
    assertNoEscapes() {
      if (escapes.length > reported) {
        reported = escapes.length;
        throw new Error(message());
      }
    },
  };
  // Ordinary Bun children have no test hooks. A caught error, including one
  // followed by process.exit(0), must still make that process unsuccessful.
  process.on("exit", () => {
    if (escapes.length) {
      console.error(message());
      process.exit(1);
    }
  });
  return installed;
}
