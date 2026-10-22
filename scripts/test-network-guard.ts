/** Test-only subprocess and transport safeguards; never imported by a published package. */
import { basename, join } from "node:path";
import { inheritWorkspaceLease } from "./workspace-lease.mjs";

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
let installed: { assertNoEscapes(): void } | undefined;

/** Test-owned repositories must not acquire detached writers behind a fixture. */
function testGitEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(count) || count < 0 || count > 2_147_483_645) {
    throw new Error("Test Git environment requires a valid GIT_CONFIG_COUNT");
  }
  // Repeated preload/child propagation must not grow the inherited config.
  if (count >= 2 && env[`GIT_CONFIG_KEY_${count - 2}`] === "maintenance.auto" &&
    env[`GIT_CONFIG_VALUE_${count - 2}`] === "false" &&
    env[`GIT_CONFIG_KEY_${count - 1}`] === "gc.auto" && env[`GIT_CONFIG_VALUE_${count - 1}`] === "0") return { ...env };
  return { ...env,
    GIT_CONFIG_COUNT: String(count + 2),
    [`GIT_CONFIG_KEY_${count}`]: "maintenance.auto", [`GIT_CONFIG_VALUE_${count}`]: "false",
    [`GIT_CONFIG_KEY_${count + 1}`]: "gc.auto", [`GIT_CONFIG_VALUE_${count + 1}`]: "0",
  };
}

export function installNetworkGuard(): { assertNoEscapes(): void } {
  if (installed) return installed;
  Object.assign(process.env, testGitEnvironment(process.env));
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
      // Resource ownership follows children even when a test replaces env or
      // cwd. Existing extra stdio channels keep their original descriptor ids.
      const defaultStderr = key === "spawnSync" ? "pipe" : "inherit";
      // The trusted worker bootstrap refuses inherited authority. Keep the
      // actual output owner in its ancestor, never pass its writable lock fd
      // into a pipe-only boundary. This is test coordination, not a worker flag.
      const pipeOnly = /\/ui-sdk\/(src|dist)\/server\/worker-entry\.(ts|js)$/.test(cmd[1] ?? "");
      const options = (Array.isArray(first) ? args[1] ?? {} : args[0]) as { env?: Record<string, string | undefined> };
      // Fixture helpers often replace env completely, including provider-history
      // probes. Carry test Git policy through those children as well as shells.
      const inherited = inheritWorkspaceLease({ ...options, env: testGitEnvironment(options.env ?? process.env) }, defaultStderr, pipeOnly);
      if (Array.isArray(first)) args[1] = inherited;
      else args[0] = inherited;
      const result = Reflect.apply(native, Bun, args);
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
