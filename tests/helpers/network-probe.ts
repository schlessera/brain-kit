import { expect, mock, spyOn } from "bun:test";
import { ScrapeClient } from "../../packages/scrape/src/fetch/http";
import { RobotsCache } from "../../packages/scrape/src/politeness/robots";
import net from "node:net";
import tls from "node:tls";

const external = "https://escape.example.invalid/data";
const client = () => new ScrapeClient({ respectRobots: false, defaultDelayMs: 0 });

export async function runProbe(scenario: string): Promise<void> {
  if (scenario === "net-connect") {
    const server = net.createServer(socket => socket.end("Ithaca"));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    process.env.PROBE_SOCKET_PORT = String(port);
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "escape.example.invalid", port });
        socket.on("error", reject);
        socket.on("data", data => { console.log(`SOCKET_REACHED=${data}`); socket.destroy(); resolve(); });
      }).catch(() => {});
    } finally {
      delete process.env.PROBE_SOCKET_PORT;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  } else if (scenario === "net-forms" || scenario === "tls-forms" || scenario === "bun-connect" || scenario === "socket-exit-zero") {
    for (const host of ["escape.example.invalid", "203.0.113.1", "2001:db8::1", "localhost.example.invalid", "127.0.0.1.example.invalid", "0.0.0.0"]) {
      const calls = scenario === "tls-forms" ? [
        () => tls.connect({ host, port: 443 }), () => tls.connect(443, host), () => tls.connect(443, { host }),
        () => new tls.TLSSocket(new net.Socket()).connect({ host, port: 443 }),
      ] : scenario === "bun-connect" ? [
        () => Bun.connect({ hostname: host, port: 443, socket: { data() {} } }),
        () => Bun.connect({ hostname: host, port: 443, tls: true, socket: { data() {} } }),
      ] : [
        () => net.connect(443, host), () => net.createConnection({ host, port: 443 }),
        () => new net.Socket().connect({ host, port: 443 }),
        () => Reflect.apply(net.Socket.prototype.connect, new net.Socket(), ["443", host]),
      ];
      for (const call of calls) try { await call(); } catch { /* Hooks must catch swallowed errors. */ }
    }
    if (scenario === "socket-exit-zero") process.exit(0);
  } else if (scenario === "socket-mocks") {
    const socketDescriptor = Object.getOwnPropertyDescriptor(net.Socket.prototype, "connect")!;
    const bunDescriptor = Object.getOwnPropertyDescriptor(Bun, "connect")!;
    try {
      Object.defineProperty(net.Socket.prototype, "connect", { ...socketDescriptor, value: function () { return this; } });
      const socket = new net.Socket();
      expect(socket.connect({ host: "escape.example.invalid", port: 443 })).toBe(socket);
      Object.defineProperty(Bun, "connect", { ...bunDescriptor, value: async () => "fixture" });
      expect(await Bun.connect({ hostname: "escape.example.invalid", port: 443, socket: { data() {} } }) as unknown).toBe("fixture");
    } finally {
      Object.defineProperty(net.Socket.prototype, "connect", socketDescriptor);
      Object.defineProperty(Bun, "connect", bunDescriptor);
    }
    spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket) { return this; });
    spyOn(Bun, "connect").mockResolvedValue("fixture" as unknown as Awaited<ReturnType<typeof Bun.connect>>);
    mock.restore();
    expect(Object.getOwnPropertyDescriptor(net.Socket.prototype, "connect")).toEqual(socketDescriptor);
    expect(Object.getOwnPropertyDescriptor(Bun, "connect")).toEqual(bunDescriptor);
    try { net.connect({ host: "escape.example.invalid", port: 443 }); } catch {}
    await Bun.connect({ hostname: "escape.example.invalid", port: 443, socket: { data() {} } }).catch(() => {});
  } else if (scenario === "local-sockets") {
    const receive = (socket: net.Socket) => new Promise<string>((resolve, reject) => {
      let text = "";
      socket.on("data", data => { text += data; }); socket.on("error", reject); socket.on("end", () => resolve(text));
    });
    const bunReceive = async (address: { hostname: string; port: number } | { unix: string }) => {
      let text = "", done!: (text: string) => void, fail!: (error: Error) => void;
      const result = new Promise<string>((resolve, reject) => { done = resolve; fail = reject; });
      const handlers: Bun.SocketHandler<undefined> = { data(_socket, data) { text += data.toString(); }, end() { done(text); }, error(_socket, error) { fail(error); } };
      const socket = await ("hostname" in address ? Bun.connect({ ...address, socket: handlers }) : Bun.connect({ ...address, socket: handlers }));
      try { return await result; } finally { socket.end(); }
    };
    for (const host of ["127.0.0.1", "127.0.0.2", "::1"]) {
      const server = net.createServer(socket => socket.end("Ithaca"));
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
      const port = (server.address() as net.AddressInfo).port;
      try {
        expect(await receive(net.connect(port, host))).toBe("Ithaca");
        expect(await receive(net.createConnection({ host, port }))).toBe("Ithaca");
        expect(await receive(new net.Socket().connect(port, host))).toBe("Ithaca");
        expect(await bunReceive({ hostname: host, port })).toBe("Ithaca");
        if (host === "127.0.0.1") {
          expect(await receive(net.connect({ port }))).toBe("Ithaca");
          expect(await receive(net.connect(port, "localhost"))).toBe("Ithaca");
          expect(await bunReceive({ hostname: "localhost", port })).toBe("Ithaca");
        }
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    }
    const path = `${process.env.PROBE_DIR}/ithaca.sock`;
    const server = net.createServer(socket => socket.end("Ithaca"));
    await new Promise<void>(resolve => server.listen(path, resolve));
    try {
      expect(await receive(net.connect(path))).toBe("Ithaca");
      expect(await receive(net.createConnection({ path }))).toBe("Ithaca");
      expect(await receive(new net.Socket().connect(path))).toBe("Ithaca");
      expect(await bunReceive({ unix: path })).toBe("Ithaca");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  } else if (scenario === "local-tls") {
    const key = `${process.env.PROBE_DIR}/key.pem`, cert = `${process.env.PROBE_DIR}/cert.pem`;
    const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1",
      "-subj", "/CN=Odysseus fixture", "-keyout", key, "-out", cert], { stdout: "pipe", stderr: "pipe" });
    expect(generated.exitCode, generated.stderr.toString()).toBe(0);
    const server = tls.createServer({ key: await Bun.file(key).text(), cert: await Bun.file(cert).text() }, socket => socket.end("Ithaca"));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const read = (socket: tls.TLSSocket) => new Promise<string>((resolve, reject) => {
      let text = ""; socket.on("data", data => { text += data; }); socket.on("error", reject); socket.on("end", () => resolve(text));
    });
    try {
      expect(await read(tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }))).toBe("Ithaca");
      expect(await read(tls.connect(port, "localhost", { rejectUnauthorized: false }))).toBe("Ithaca");
      // An adopted stream keeps its actual local destination even with external SNI.
      const socket = net.connect(port, "127.0.0.1");
      expect(await read(tls.connect({ socket, servername: "escape.example.invalid", rejectUnauthorized: false }))).toBe("Ithaca");
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  } else if (scenario === "partial") {
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
