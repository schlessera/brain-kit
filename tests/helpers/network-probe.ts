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
  } else if (scenario === "gog-forms") {
    // A harmless stand-in named gog. Every attempt names it absolutely or
    // finds it on an explicit PATH holding nothing else, so a form that
    // escaped the guard could only run the stand-in, which leaves a mark the
    // sentinel reports as native. No attempt can reach an installed gog.
    const { mkdirSync, readFileSync, symlinkSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const bin = join(process.env.PROBE_DIR!, "gog-bin");
    mkdirSync(bin, { recursive: true });
    const gog = join(bin, "gog");
    writeFileSync(gog, `#!/bin/sh\nprintf 'gog ran %s\\n' "$*" >> '${join(process.env.PROBE_DIR!, "native-gog")}'\n`, { mode: 0o755 });
    const renamed = join(bin, "renamed");
    symlinkSync(gog, renamed);
    const env = { PATH: bin };
    const settle = async (value: unknown) => {
      if (value && typeof value === "object" && "exited" in value) await (value as { exited: Promise<unknown> }).exited;
      else if (value && typeof value === "object" && "once" in value) await new Promise<void>(resolve => (value as { once(event: string, done: () => void): void }).once("exit", () => resolve()));
    };
    // Registration takes only a fake the fake-gog helper made, and only while
    // its file is still that fake: a registered stand-in or a registered
    // /bin/true would let every spawn below through.
    const { fakeGogShim, registerFakeGog } = await import("../../scripts/test-network-guard");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    // The fake's own bytes outside the helper's place, and the stand-in's bytes in it.
    const elsewhere = join(process.env.PROBE_DIR!, "fake-gog-Ithaca", "bin", "gog");
    mkdirSync(join(elsewhere, ".."), { recursive: true });
    writeFileSync(elsewhere, fakeGogShim(elsewhere), { mode: 0o700 });
    const impostorDir = mkdtempSync(join(tmpdir(), "fake-gog-"));
    const impostor = join(impostorDir, "bin", "gog");
    mkdirSync(join(impostor, ".."));
    writeFileSync(impostor, readFileSync(gog), { mode: 0o700 });
    for (const [label, path] of [["stand-in", gog], ["true", "/bin/true"], ["elsewhere", elsewhere], ["impostor", impostor]] as const) {
      try {
        registerFakeGog(path);
        console.log(`GOG_REGISTRATION=${label}:accepted`);
      } catch {
        console.log(`GOG_REGISTRATION=${label}:refused`);
      }
    }
    const { createFakeGog } = await import("../../packages/common/tests/support/fake-gog");
    const replaced = createFakeGog({});
    writeFileSync(replaced.executable, readFileSync(gog));
    for (const key of ["spawn", "spawnSync"] as const) {
      for (const cmd of [["gog", "version"], [gog, "version"], [renamed, "version"], [replaced.executable, "version"], [impostor, "version"],
        ["/usr/bin/env", "gog", "version"],
        ["/bin/sh", "-c", "gog version"], ["/bin/sh", "-ec", `exec ${gog} version`],
        // Wrappers inside wrappers, and the renamed link through each.
        ["/usr/bin/env", "/bin/sh", "-c", "gog version"], ["/usr/bin/env", "-S", "gog version"], ["/usr/bin/env", "-u", "HOME", "renamed", "version"],
        ["/usr/bin/env", "-i", `PATH=${bin}`, "/bin/sh", "-c", "renamed version"], ["/usr/bin/env", "/usr/bin/env", "/bin/sh", "-c", "renamed version"],
        ["/bin/sh", "-c", `exec ${renamed} version`], ["/bin/sh", "-c", "/usr/bin/env renamed version"], ["/bin/sh", "-c", "/bin/sh -c 'renamed version'"]]) {
        for (const args of [[cmd, { env }], [{ cmd, env }]]) {
          try { await settle(Reflect.apply(Bun[key], Bun, args)); } catch {}
        }
      }
    }
    const cp = await import("node:child_process");
    for (const attempt of [
      () => cp.execSync("gog version", { env }), () => cp.execFileSync("gog", ["version"], { env }), () => cp.spawnSync("gog", ["version"], { env }),
      () => cp.exec("gog version", { env }), () => cp.spawn("gog version", { shell: true, env }), () => cp.execFile(gog, ["version"], { env }),
    ]) {
      try { await settle(attempt()); } catch {}
    }
    try { await Bun.$`gog version`.env(env).quiet(); } catch {}
    try { await Bun.$`${gog} version`.env(env).quiet(); } catch {}
    try { await Bun.$`${renamed} version`.env(env).quiet(); } catch {}
    try { await Bun.$`renamed version`.env(env).quiet(); } catch {}
    try { await Bun.$`renamed version`.cwd(bin).env(env).quiet(); } catch {}
    try { await Bun.$.env(env)`renamed version`.quiet(); } catch {}
    Bun.$.env(undefined);
    replaced.dispose();
    const { rmSync } = await import("node:fs");
    rmSync(impostorDir, { recursive: true, force: true });
  } else if (scenario === "gog-environment") {
    // A form token matching does not see (shell quoting splits the name), so
    // the guard lets it through, and the stand-in, a Bun script found on an
    // explicit PATH holding nothing else, reports what it was given. What is
    // under test is that even this finds no account to use.
    const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const bin = join(process.env.PROBE_DIR!, "gog-bin");
    mkdirSync(bin, { recursive: true });
    const report = join(process.env.PROBE_DIR!, "gog-env.json");
    writeFileSync(join(bin, "gog"), `#!${process.execPath}
import { readdirSync, statSync, writeFileSync } from "node:fs";
const home = process.env.GOG_HOME ?? "";
let state = null;
try { const stats = statSync(home); state = { dir: stats.isDirectory(), entries: readdirSync(home).length, mode: (stats.mode & 0o777).toString(8), uid: stats.uid }; } catch {}
writeFileSync(${JSON.stringify(report)}, JSON.stringify({ gog: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("GOG_"))), home: state }));
`, { mode: 0o755 });
    const child = Bun.spawnSync(["/bin/sh", "-c", "go\"\"g version"], { env: { ...process.env, PATH: bin }, stdout: "pipe", stderr: "pipe" });
    console.log(`GOG_ENV_EXIT=${child.exitCode}`);
    console.log(`GOG_ENV=${readFileSync(report, "utf8")}`);
  } else if (scenario === "gog-home-descendants") {
    // Children the guard starts, given this process's environment or another,
    // report the gog home they were given. Two are killed with SIGKILL, which
    // runs no exit hook; the last exits normally.
    const { existsSync } = await import("node:fs");
    const own = process.env.GOG_HOME!;
    const children = [
      [undefined, 'process.kill(process.pid, "SIGKILL")'],
      [{ PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR! }, 'process.kill(process.pid, "SIGKILL")'],
      [undefined, "process.exit(0)"],
    ].map(([env, exit]) => {
      const program = `require("node:fs").writeSync(1, process.env.GOG_HOME ?? ""); ${exit}`;
      const child = Bun.spawnSync([process.execPath, "-e", program], { ...(env ? { env: env as Record<string, string> } : {}), stdout: "pipe", stderr: "pipe" });
      return { home: child.stdout.toString(), signal: child.signalCode ?? null, exit: child.exitCode };
    });
    console.log(`GOG_HOMES=${JSON.stringify({ own, children, own_after: existsSync(own) })}`);
  } else if (scenario === "google-host-environment") {
    // Which of the host's Google settings this test process, a Bun child and
    // a shell child it starts with its environment hold, and whether an
    // ordinary variable reached all three.
    const names = ["BRAIN_UI_GOOGLE_HOME", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD", "BRAIN_UI_GOG_PATH", "BRAIN_GOOGLE_LEDGER", "ODYSSEUS_VOYAGE"];
    const held = (env: Record<string, string | undefined>) => names.filter(name => env[name] !== undefined);
    const fromChild = (cmd: string[]) => held(JSON.parse(Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" }).stdout.toString()));
    const program = `console.log(JSON.stringify(process.env))`;
    console.log(`GOOGLE_HOST_ENV=${JSON.stringify({
      own: held(process.env),
      bun: fromChild([process.execPath, "-e", program]),
      shell: fromChild(["/bin/sh", "-c", `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(program).replaceAll("$", "\\$")}`]),
    })}`);
  } else if (scenario === "dotenv-descendants") {
    // A sanitized test process starts Bun children that read host settings
    // from a dotenv file before their preload runs: a .env in the working
    // directory (with two forged notes, one by variable expansion), an
    // explicit --env-file, one in BUN_OPTIONS, and a Bun that `bun run`'s
    // package script starts. A Bun that a shell starts without the preload,
    // from each way a test starts one, reads no .env at all. Each child
    // reports the host-only names and XDG bases it holds. The test passes one
    // synthetic Google value and one XDG base explicitly.
    const { chmodSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const root = join(process.env.PROBE_DIR!, "dotenv");
    const host = ["BRAIN_UI_GOOGLE_HOME=/srv/ithaca/gog", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD=suitors-feast", "BRAIN_UI_GOG_PATH=/srv/ithaca/bin/gog",
      "BRAIN_GOOGLE_LEDGER=/srv/ithaca/google-ledger.sqlite", "APIFY_TOKEN=apify-suitor", "XDG_CONFIG_HOME=/srv/ithaca/xdg-config", "ODYSSEUS_DOTENV=loaded"];
    for (const dir of ["cwd", "run", "plain"]) mkdirSync(join(root, dir), { recursive: true });
    // A file a guard did not write, shaped like one it did.
    const forged = join(root, "forged-chosen.json");
    writeFileSync(forged, JSON.stringify({ BRAIN_UI_GOOGLE_KEYRING_PASSWORD: "forged-feast", XDG_CONFIG_HOME: "/srv/ithaca/forged-config" }), { mode: 0o600 });
    chmodSync(forged, 0o600);
    writeFileSync(join(root, "cwd", ".env"), [...host, "BRAIN_TEST_GUARD_ENV_FILES_OFF=$GOG_HOME", `BRAIN_TEST_GUARD_CHOSEN_ENV=${forged}`, ""].join("\n"));
    writeFileSync(join(root, "run", ".env"), [...host, ""].join("\n"));
    writeFileSync(join(root, "run", "package.json"), JSON.stringify({ name: "ithaca-dotenv-probe", private: true,
      scripts: { nested: 'exec "$ODYSSEUS_BUN" --preload "$ODYSSEUS_PRELOAD" -e "$ODYSSEUS_REPORT"',
        "nested-dotenv": 'BUN_OPTIONS= exec "$ODYSSEUS_BUN" --preload "$ODYSSEUS_PRELOAD" -e "$ODYSSEUS_REPORT"',
        unguarded: 'exec "$ODYSSEUS_BUN" -e "$ODYSSEUS_REPORT"' } }));
    const hostFile = join(root, "host.env");
    writeFileSync(hostFile, [...host, ""].join("\n"));
    const names = ["BRAIN_UI_GOOGLE_HOME", "BRAIN_UI_GOOGLE_KEYRING_PASSWORD", "BRAIN_UI_GOG_PATH", "BRAIN_GOOGLE_LEDGER", "APIFY_TOKEN",
      "XDG_CONFIG_HOME", "XDG_DATA_HOME", "ODYSSEUS_DOTENV", "BRAIN_GOOGLE_HOME", "BRAIN_TEST_GUARD_CHOSEN_ENV"];
    const report = `console.log("DOTENV_CHILD=" + JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(name => [name, process.env[name] ?? null]))))`;
    writeFileSync(join(root, "cwd", "dotenv-child.test.ts"), `import { test } from "bun:test";\ntest("reports", () => { ${report}; });\n`);
    writeFileSync(join(root, "cwd", "dotenv-report.ts"), `${report};\n`);
    const preload = join(import.meta.dir, "../../scripts/test-network-child-preload.ts");
    const env = { ...process.env, BRAIN_GOOGLE_HOME: "/odysseus/synthetic-standalone-home", XDG_DATA_HOME: "/odysseus/xdg-data",
      ODYSSEUS_BUN: process.execPath, ODYSSEUS_PRELOAD: preload, ODYSSEUS_REPORT: report } as Record<string, string>;
    // This probe runs under an alias the spawn wrapper does not treat as Bun, so
    // it holds the BUN_OPTIONS a shell is given. A test process that Bun or the
    // wrapper starts holds none, and its Bun children are what this models.
    delete env.BUN_OPTIONS;
    const held = (cmd: string[], cwd: string, extra: Record<string, string> = {}) => {
      const child = Bun.spawnSync(cmd, { cwd: join(root, cwd), env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
      const line = `${child.stdout}${child.stderr}`.split("\n").find(text => text.startsWith("DOTENV_CHILD="));
      return line ? JSON.parse(line.slice("DOTENV_CHILD=".length)) : { exit: child.exitCode, output: `${child.stdout}${child.stderr}`.slice(-400) };
    };
    const reported = (output: string) => {
      const line = output.split("\n").find(text => text.startsWith("DOTENV_CHILD="));
      return line ? JSON.parse(line.slice("DOTENV_CHILD=".length)) : { output: output.slice(-400) };
    };
    // A Bun a shell starts, with no preload: from Bun.spawnSync, node:child_process and Bun Shell.
    const cp = await import("node:child_process");
    const unguarded = 'exec "$0" ./dotenv-report.ts';
    const viaNode = cp.spawnSync("/bin/sh", ["-c", unguarded, process.execPath], { cwd: join(root, "cwd"), env, encoding: "utf8" });
    const viaShell = await Bun.$`${process.execPath} ./dotenv-report.ts`.cwd(join(root, "cwd")).env(env).quiet().nothrow();
    console.log(`DOTENV_CHILDREN=${JSON.stringify({
      guard: dirname(process.env.GOG_HOME!),
      children: {
        "bun-eval": held([process.execPath, "-e", report], "cwd"),
        "bun-test": held([process.execPath, "test", "./dotenv-child.test.ts"], "cwd"),
        "shell-unguarded": held(["/bin/sh", "-c", unguarded, process.execPath], "cwd"),
        "node-shell-unguarded": reported(`${viaNode.stdout}${viaNode.stderr}`),
        "bun-shell-unguarded": reported(`${viaShell.stdout}${viaShell.stderr}`),
        // This shell empties BUN_OPTIONS, so its Bun reads the .env, forged notes and all.
        shell: held(["/bin/sh", "-c", 'BUN_OPTIONS= exec "$0" --preload "$1" -e "$2"', process.execPath, preload, report], "cwd"),
        "bun-run": held([process.execPath, "run", "nested"], "run"),
        // This script empties BUN_OPTIONS, so its Bun reads the .env.
        "bun-run-dotenv": held([process.execPath, "run", "nested-dotenv"], "run"),
        "bun-run-unguarded": held([process.execPath, "run", "unguarded"], "run"),
        // The same package script run by its bare name, which dispatches as bun run does.
        "bun-script-unguarded": held([process.execPath, "unguarded"], "run"),
        "env-file": held([process.execPath, `--env-file=${hostFile}`, "-e", report], "plain"),
        "bun-options": held([process.execPath, "-e", report], "plain", { BUN_OPTIONS: `--env-file=${hostFile}` }),
      },
    })}`);
  } else if (scenario === "gog-filtered-environment") {
    // A shell child given the product-filtered environment of the agent
    // audience, which drops GOG_HOME and GOG_KEYRING_BACKEND, runs a gog form
    // token matching does not see. The stand-in reports where gog 0.48.1
    // would look for its directories and which keyring it would pick in that
    // environment (internal/config/layout.go `resolveKind`, `defaultBase`;
    // internal/secrets/backend.go `shouldForceFileBackend`, Linux).
    const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const cp = await import("node:child_process");
    const { filterSubprocessEnv } = await import("../../packages/ui-sdk/src/server/subprocess-env.ts");
    const bin = join(process.env.PROBE_DIR!, "gog-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gog"), `#!${process.execPath}
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
const env = process.env;
const absolute = value => typeof value === "string" && value.trim().startsWith("/") ? value.trim() : null;
const base = (name, fallback) => absolute(env[name]) ?? (env.HOME ? env.HOME + fallback : null);
const gogHome = absolute(env.GOG_HOME);
const dirs = gogHome ? { config: gogHome + "/config", data: gogHome + "/data", state: gogHome + "/state", cache: gogHome + "/cache" } : {
  config: base("XDG_CONFIG_HOME", "/.config") + "/gogcli", data: base("XDG_DATA_HOME", "/.local/share") + "/gogcli",
  state: base("XDG_STATE_HOME", "/.local/state") + "/gogcli", cache: base("XDG_CACHE_HOME", "/.cache") + "/gogcli",
};
let configured = null;
try { configured = JSON.parse(readFileSync(dirs.config + "/config.json", "utf8")).keyring_backend ?? null; } catch {}
const backend = (env.GOG_KEYRING_BACKEND ?? "").trim().toLowerCase() || configured || "auto";
const dbus = Boolean(env.DBUS_SESSION_BUS_ADDRESS) && env.DBUS_SESSION_BUS_ADDRESS !== "disabled:";
writeFileSync(env.ITHACA_REPORT, JSON.stringify({
  gog: Object.keys(env).filter(name => name.startsWith("GOG_")).sort(),
  home: env.HOME ?? null,
  xdg: Object.fromEntries(["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"].map(name => [name, env[name] ?? null])),
  dirs, entries: Object.fromEntries(Object.entries(dirs).map(([kind, dir]) => [kind, existsSync(dir) ? readdirSync(dir).length : null])),
  keyring: backend === "auto" ? (dbus ? "secret-service" : "file") : backend,
}));
`, { mode: 0o755 });
    const filtered = filterSubprocessEnv(process.env, "agent");
    const reports: Record<string, unknown> = {};
    const run = async (label: string, start: (env: Record<string, string>) => unknown) => {
      const report = join(process.env.PROBE_DIR!, `gog-${label}.json`);
      const env = { ...filtered, PATH: bin, ITHACA_REPORT: report } as Record<string, string>;
      try { await start(env); } catch { /* the stand-in's report, or its absence, is the evidence */ }
      try { reports[label] = JSON.parse(readFileSync(report, "utf8")); } catch { reports[label] = null; }
    };
    await run("bun-spawn", env => Bun.spawnSync(["/bin/sh", "-c", "go\"\"g version"], { env, stdout: "pipe", stderr: "pipe" }));
    await run("child-process", env => cp.execFileSync("/bin/sh", ["-c", "go\"\"g version"], { env, stdio: "pipe" }));
    await run("bun-shell", env => Bun.$`go""g version`.env(env).quiet());
    console.log(`GOG_FILTERED=${JSON.stringify({ guard: process.env.GOG_HOME, home: process.env.HOME, filtered: Object.keys(filtered).sort(), reports })}`);
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
  } else if (scenario === "local-unix") {
    // A Unix-socket fetch keeps its socket under the guard; the URL's host is
    // only the request's Host header (#3431).
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { createServer } = await import("node:http");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/probe-unix-`);
    const server = createServer((request, response) => response.end(`UNIX:${request.url}`));
    await new Promise<void>(resolve => server.listen(`${dir}/probe.sock`, resolve));
    try {
      expect(await (await fetch("http://localhost/fixture", { unix: `${dir}/probe.sock` } as RequestInit)).text()).toBe("UNIX:/fixture");
    } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
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
