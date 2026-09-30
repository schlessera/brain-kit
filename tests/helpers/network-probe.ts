import { expect, mock, spyOn } from "bun:test";
import { ScrapeClient } from "../../packages/scrape/src/fetch/http";
import { RobotsCache } from "../../packages/scrape/src/politeness/robots";

const external = "https://escape.example.invalid/data";
const client = () => new ScrapeClient({ respectRobots: false, defaultDelayMs: 0 });

export async function runProbe(scenario: string): Promise<void> {
  if (scenario === "partial") {
    class PartialClient extends ScrapeClient {
      override async getText() { return "fixture"; }
    }
    const partial = new PartialClient({ respectRobots: false, defaultDelayMs: 0 });
    await partial.getJson(external, { retries: 0 }).catch(() => {});
  } else if (scenario === "robots") {
    // RobotsCache deliberately catches errors and permits the request.
    await new RobotsCache().forUrl(external);
  } else if (scenario === "proxy") {
    await client().get(external, { proxy: "http://proxy.example.invalid:8080", retries: 0 }).catch(() => {});
  } else if (scenario === "curl-forms") {
    for (const key of ["spawn", "spawnSync"] as const) {
      for (const cmd of [["curl", external], ["/usr/bin/curl", external]]) {
        for (const arg of [cmd, { cmd }]) {
          try { Reflect.apply(Bun[key], Bun, [arg]); } catch {}
        }
      }
    }
  } else if (scenario === "hosts") {
    for (const input of [external, new URL(external), new Request(external),
      "https://localhost.example.invalid/", "http://127.0.0.2/", "http://0.0.0.0/", "file:///etc/hosts"]) {
      // The sentinel refuses everything except the exact fixture hosts.
      // File URLs are rejected by the guard before nativeFetch too.
      await fetch(input).catch(() => {});
    }
  } else if (scenario === "retries") {
    await client().get(external, { retries: 1, retryDelayMs: 0 }).catch(() => {});
  } else if (scenario === "exit-zero") {
    await fetch(external).catch(() => {});
    process.exit(0);
  } else if (scenario === "mocks" || scenario === "restore-only") {
    const savedFetch = fetch;
    const savedSpawn = Bun.spawn;
    globalThis.fetch = Object.assign(async () => new Response("assigned mock"), savedFetch);
    expect(await (await fetch(external)).text()).toBe("assigned mock");
    globalThis.fetch = savedFetch;
    spyOn(globalThis, "fetch").mockResolvedValue(new Response("spy mock"));
    expect(await (await fetch(external)).text()).toBe("spy mock");
    spyOn(Bun, "spawn").mockImplementation((() => "spawn mock") as unknown as typeof Bun.spawn);
    expect(Bun.spawn(["curl", external]) as unknown).toBe("spawn mock");
    mock.restore();
    expect(fetch).toBe(savedFetch);
    expect(Bun.spawn).toBe(savedSpawn);
    if (scenario === "mocks") await fetch(external).catch(() => {});
  } else if (scenario.startsWith("child-")) {
    const body = `await fetch(${JSON.stringify(external)}).catch(() => {});`;
    const cmd = scenario === "child-test" ? [process.env.PROBE_BUN!, "test", "--config=./child.toml", "./child.test.ts"] :
      [process.env.PROBE_BUN!, "-e", body + "process.exit(0);"];
    if (scenario === "child-test") {
      await Bun.write(`${process.env.PROBE_DIR}/child.toml`, "# Deliberately no test preload: the parent must propagate it.\n");
      await Bun.write(`${process.env.PROBE_DIR}/child.test.ts`, `import {test} from "bun:test"; test("caught child escape", async () => { ${body} });`);
    }
    const options = { cwd: process.env.PROBE_DIR!, env: { PATH: process.env.PATH! }, stdout: "pipe" as const, stderr: "pipe" as const };
    if (scenario === "child-sync") {
      const child = Bun.spawnSync({ cmd, ...options });
      console.log(new TextDecoder().decode(child.stdout));
      console.error(new TextDecoder().decode(child.stderr));
      expect(child.exitCode).not.toBe(0);
    } else {
      const child = scenario === "child-object" ? Bun.spawn({ cmd, ...options }) : Bun.spawn(cmd, options);
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      console.log(out);
      console.error(err);
      expect(code).not.toBe(0);
    }
  } else if (["local", "redirect", "redirect-error", "manual"].includes(scenario)) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/outside") return Response.redirect(external);
      if (path === "/hop") return Response.redirect("/fixture", 302);
      if (path === "/keep") return Response.redirect("/echo", 307);
      if (path === "/echo") return new Response(`${request.method}:${await request.text()}`);
      return new Response(`${request.method}:fixture`, { status: 200 });
    } });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      if (scenario === "local") {
        expect(await (await fetch(base + "/fixture")).text()).toBe("GET:fixture");
        expect(await (await fetch(new Request(base + "/hop", { method: "POST", body: "body" }))).text()).toBe("GET:fixture");
        expect(await (await fetch(base + "/hop")).text()).toBe("GET:fixture");
        expect(await (await fetch(base + "/keep", { method: "POST", body: "payload" })).text()).toBe("POST:payload");
        const controller = new AbortController();
        controller.abort();
        await expect(fetch(base + "/fixture", { signal: controller.signal })).rejects.toThrow();
      } else if (scenario === "manual") {
        expect((await fetch(base + "/outside", { redirect: "manual" })).status).toBe(302);
      } else if (scenario === "redirect-error") {
        await expect(fetch(base + "/outside", { redirect: "error" })).rejects.toThrow();
      } else {
        await fetch(base + "/outside").catch(() => {});
      }
    } finally { server.stop(true); }
  } else {
    throw new Error(`Unknown probe ${scenario}`);
  }
}
