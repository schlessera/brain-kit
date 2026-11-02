/**
 * A loopback smart-HTTP Git server over bare repositories in `root`, keyless
 * and offline. Every request needs Basic auth with the synthetic `token`;
 * `received` records each path and whether it carried that credential.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GIT_FIXTURE_ENV = { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

export function fixtureGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["/usr/bin/git", "-C", cwd, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example", ...args],
    { stdout: "pipe", stderr: "pipe", env: GIT_FIXTURE_ENV });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

/** One bare repository `<root>/<owner>/<name>.git` on branch `watch`, holding `scripts/beacon.ts`. */
export function fixtureRepository(root: string, owner: string, name: string, text: string): string {
  const work = join(root, `${owner}-${name}-work`), bare = join(root, owner, `${name}.git`);
  mkdirSync(join(work, "scripts"), { recursive: true }); mkdirSync(join(root, owner), { recursive: true });
  fixtureGit(work, "init", "-q", "-b", "watch");
  writeFileSync(join(work, "scripts/beacon.ts"), `console.log(${JSON.stringify(text)});\n`);
  fixtureGit(work, "add", "."); fixtureGit(work, "commit", "-q", "-m", `${name}: ${text}`);
  fixtureGit(root, "clone", "-q", "--bare", work, bare);
  fixtureGit(bare, "config", "http.uploadpack", "true");
  return bare;
}

export function serveGitFixture(root: string, token: string) {
  const basic = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const received: { path: string; authorized: boolean }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), authorized = request.headers.get("authorization") === basic;
    received.push({ path: url.pathname, authorized });
    if (!authorized) return new Response("credentials required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="ithaca"' } });
    const body = new Uint8Array(await request.arrayBuffer());
    const child = Bun.spawn(["/usr/bin/git", "http-backend"], { stdin: body, stdout: "pipe", stderr: "pipe", env: {
      ...GIT_FIXTURE_ENV, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REQUEST_METHOD: request.method, PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers.get("content-type") ?? "", CONTENT_LENGTH: String(body.length),
    } });
    const [output, stderr, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) return new Response(stderr, { status: 500 });
    const bytes = new Uint8Array(output), separator = Buffer.from(bytes).indexOf("\r\n\r\n");
    if (separator < 0) return new Response("missing CGI headers", { status: 500 });
    const headers = new Headers(); let status = 200;
    for (const line of new TextDecoder().decode(bytes.slice(0, separator)).split("\r\n")) {
      const colon = line.indexOf(":"), name = line.slice(0, colon), value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]); else headers.append(name, value);
    }
    return new Response(bytes.slice(separator + 4), { status, headers });
  } });
  return { server, received, origin: new URL(server.url).origin, url: (path: string) => `${server.url}${path}` };
}
