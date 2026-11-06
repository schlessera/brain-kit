/** #3612 offline qualification only. Nothing here is imported by production. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaintenanceCommand } from "@schlessera/brain-ui-sdk/internal";
import type { runMaintenanceWorker } from "@schlessera/brain-ui-sdk/internal";

export const gitEnv = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@ithaca.example",
  GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@ithaca.example", GIT_AUTHOR_DATE: "2026-07-12T10:00:00Z", GIT_COMMITTER_DATE: "2026-07-12T10:00:00Z" };
export interface Exit { code: number; stdout: string; stderr: string }
export const receipts: { args: string[]; code: number }[] = [];
export async function git(cwd: string, ...args: string[]): Promise<Exit> {
  const child = Bun.spawn(["/usr/bin/git", "-C", cwd, ...args], { env: gitEnv, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  receipts.push({ args, code });
  return { code, stdout: stdout.trim(), stderr };
}
export async function checked(cwd: string, ...args: string[]): Promise<string> {
  const result = await git(cwd, ...args);
  if (result.code !== 0) throw new Error(`git ${args[0]} exit ${result.code}: ${result.stderr}`);
  return result.stdout;
}

/** Execute the production transport's exact argv/env with real Git, not its native sandbox. */
export function localRunner(launches: MaintenanceCommand[]): typeof runMaintenanceWorker {
  return (async (input: MaintenanceCommand & { signal?: AbortSignal; timeoutMs?: number }) => {
    launches.push(input);
    input.signal?.throwIfAborted();
    // Keep the experiment's real Git helper tree bounded too. This is not the production launcher.
    const child = Bun.spawn(["/usr/bin/setsid", ...input.command], { env: input.env, stdout: "pipe", stderr: "pipe" });
    let killed = false;
    const stop = () => { killed = true; try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
    input.signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, Math.min(input.timeoutMs ?? 10_000, 10_000));
    try {
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      receipts.push({ args: ["setsid", ...input.command], code: exitCode });
      return { stdout, stderr, exitCode, killed };
    } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", stop); }
  }) as typeof runMaintenanceWorker;
}

export interface Repo { path: string; directory: string; token: string | null }
export interface RequestFact { path: string; protocol: string | null; authorized: boolean; body: string }
export function origin(repos: Repo[]) {
  const facts: RequestFact[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), repo = repos.find(item => url.pathname.startsWith(`${item.path}/`));
    if (!repo) return new Response("not found", { status: 404 });
    const token = repo.token, auth = request.headers.get("authorization");
    const authorized = token === null ? auth === null : auth === `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    const body = new Uint8Array(await request.arrayBuffer()), protocol = request.headers.get("git-protocol");
    facts.push({ path: url.pathname, protocol, authorized, body: new TextDecoder().decode(body) });
    if (!authorized) return new Response("credentials required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="ithaca"' } });
    const child = Bun.spawn(["/usr/bin/git", "http-backend"], { stdin: body, stdout: "pipe", stderr: "pipe", env: {
      ...gitEnv, GIT_PROJECT_ROOT: repo.directory, GIT_HTTP_EXPORT_ALL: "1", HTTP_GIT_PROTOCOL: protocol ?? "",
      REQUEST_METHOD: request.method, PATH_INFO: url.pathname.slice(repo.path.length), QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: request.headers.get("content-type") ?? "", CONTENT_LENGTH: String(body.length),
    } });
    const [output, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    receipts.push({ args: ["http-backend", url.pathname], code });
    if (code !== 0) return new Response(stderr, { status: 500 });
    const bytes = Buffer.from(output), separator = bytes.indexOf("\r\n\r\n"), headers = new Headers();
    if (separator < 0) throw new Error("missing CGI headers");
    let status = 200;
    for (const line of bytes.subarray(0, separator).toString().split("\r\n")) {
      const colon = line.indexOf(":"), name = line.slice(0, colon), value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]); else headers.append(name, value);
    }
    return new Response(bytes.subarray(separator + 4), { status, headers });
  } });
  return { server, facts };
}

/** Deliberately insufficient candidate: endpoint filtering does not bind protocol-v2 refs. */
export function candidateRelay(upstream: URL, path: string, token: string) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const discovery = request.method === "GET" && url.pathname === `${path}/info/refs` && url.search === "?service=git-upload-pack";
    const read = request.method === "POST" && url.pathname === `${path}/git-upload-pack` && url.search === "";
    if (!discovery && !read) return new Response("unsupported", { status: 403 });
    const headers = new Headers({ authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` });
    for (const name of ["content-type", "git-protocol"]) if (request.headers.has(name)) headers.set(name, request.headers.get(name)!);
    return fetch(new URL(url.pathname + url.search, upstream), { method: request.method, headers, redirect: "manual",
      ...(read ? { body: await request.arrayBuffer() } : {}) });
  } });
  return server;
}

export function scratch() {
  const root = mkdtempSync(join(tmpdir(), "git-read-qualification-"));
  return { root, dir(name: string) { const path = join(root, name); mkdirSync(path, { recursive: true }); return path; },
    close() { rmSync(root, { force: true, recursive: true }); } };
}

export interface Identity { id: string; owner: string; name: string }
export type Selector = { kind: "repo"; id: string; owner: string } | { kind: "owner"; owner: string };
/** Fixture for the selected restrictive identity semantics; metadata must be host-verified. */
export function matches(selector: Selector, identity: Identity | null): boolean {
  return identity !== null && identity.owner.toLowerCase() === selector.owner.toLowerCase()
    && (selector.kind === "owner" || identity.id === selector.id);
}

/** Host-bound immutable objects only: never open the worker's mutable worktree path. */
export async function immutableBlob(mirror: string, commit: string, path: string): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(commit) || !/^[A-Za-z0-9._/-]+$/.test(path) || path.split("/").some(x => !x || x === "." || x === ".." || x === ".git")) throw new Error("unsupported path");
  const entry = await checked(mirror, "ls-tree", commit, "--", path);
  if (!/^(100644|100755) blob [0-9a-f]{40}\t/.test(entry) || entry.split("\n").length !== 1) throw new Error("not an immutable regular blob");
  const oid = entry.split(" ")[2]!.split("\t")[0]!;
  return checked(mirror, "cat-file", "blob", oid);
}
