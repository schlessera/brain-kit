// The private relay socket directory (#4764): both halves against real
// directories and Unix sockets, and the launcher's three call sites with a
// widened directory mode.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  conformingPrivateSocket,
  createPrivateSocketDirectory,
  securePrivateSocket,
  verifyPrivateSocketDirectory,
} from "../src/server/private-socket-dir";
import { workerCommand } from "../src/server/worker-launcher";
import { PROVIDER_RELAY_SOCKET_NAME } from "../src/server/provider-relay";

const roots: string[] = [];
const servers: Server[] = [];
afterAll(() => {
  for (const server of servers) server.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "private-socket-ithaca-"));
  roots.push(dir);
  return dir;
}

async function listen(path: string): Promise<void> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>(resolve => server.listen(path, resolve));
}

/** The expected modes, spelled out here rather than taken from the module under test. */
const MODES = { private: { dir: 0o700, socket: 0o600 }, separate: { dir: 0o750, socket: 0o660 } } as const;
const dirMode = (separate: boolean) => MODES[separate ? "separate" : "private"].dir;
const sockMode = (separate: boolean) => MODES[separate ? "separate" : "private"].socket;

/** A conforming layout: `<base>/relay` holding `relay.sock`, with the brain beside it. */
async function layout(separate: boolean, base = root()) {
  const brain = join(base, "brain"), dir = join(base, "relay"), socket = join(dir, "relay.sock");
  mkdirSync(brain, { recursive: true });
  mkdirSync(dir);
  chmodSync(dir, dirMode(separate));
  await listen(socket);
  chmodSync(socket, sockMode(separate));
  return { base, brain, dir, socket };
}

describe("verifyPrivateSocketDirectory", () => {
  for (const separate of [false, true]) {
    describe(`separate identity ${separate}`, () => {
      test("accepts the conforming layout", async () => {
        const f = await layout(separate);
        expect(verifyPrivateSocketDirectory(f.dir, "relay.sock", f.brain, separate)).toBe(f.dir);
      });

      test("refuses a directory mode one bit wider", async () => {
        const f = await layout(separate);
        chmodSync(f.dir, dirMode(separate) | 0o001);
        expect(verifyPrivateSocketDirectory(f.dir, "relay.sock", f.brain, separate)).toBeUndefined();
      });

      test("refuses a socket mode one bit wider", async () => {
        const f = await layout(separate);
        chmodSync(f.socket, sockMode(separate) | 0o004);
        expect(verifyPrivateSocketDirectory(f.dir, "relay.sock", f.brain, separate)).toBeUndefined();
      });

      test("refuses a requested path that is a symlink to the directory", async () => {
        const f = await layout(separate);
        const link = join(f.base, "relay-link");
        symlinkSync(f.dir, link);
        expect(verifyPrivateSocketDirectory(link, "relay.sock", f.brain, separate)).toBeUndefined();
      });

      test("refuses a regular file where the socket should be", async () => {
        const f = await layout(separate);
        writeFileSync(join(f.dir, "file.sock"), "");
        chmodSync(join(f.dir, "file.sock"), sockMode(separate));
        expect(verifyPrivateSocketDirectory(f.dir, "file.sock", f.brain, separate)).toBeUndefined();
      });

      test("refuses a missing socket", async () => {
        const f = await layout(separate);
        expect(verifyPrivateSocketDirectory(f.dir, "missing.sock", f.brain, separate)).toBeUndefined();
      });

      test("refuses the directory inside the brain", async () => {
        const base = root();
        const f = await layout(separate, join(base, "brain-outer"));
        expect(verifyPrivateSocketDirectory(f.dir, "relay.sock", f.base, separate)).toBeUndefined();
      });

      test("refuses the brain inside the directory", async () => {
        const f = await layout(separate);
        mkdirSync(join(f.dir, "brain"));
        expect(verifyPrivateSocketDirectory(f.dir, "relay.sock", join(f.dir, "brain"), separate)).toBeUndefined();
      });
    });
  }

  // Ownership rows need a group other than the process's own that this
  // process may actually assign: root can choose one, an ordinary user only a
  // supplementary group its user namespace maps. Elsewhere they are not
  // exercised.
  const otherGroup = (() => {
    const candidates = process.getuid?.() === 0 ? [process.getgid!() + 1]
      : (process.getgroups?.() ?? []).filter(group => group !== process.getgid?.());
    const probe = mkdtempSync(join(tmpdir(), "private-socket-group-"));
    try {
      return candidates.find(group => { try { chownSync(probe, -1, group); return true; } catch { return false; } });
    } finally { rmSync(probe, { recursive: true, force: true }); }
  })();
  test.skipIf(otherGroup === undefined)("under a separate identity, refuses a directory or socket of another group", async () => {
    const directory = await layout(true);
    chownSync(directory.dir, -1, otherGroup!);
    expect(verifyPrivateSocketDirectory(directory.dir, "relay.sock", directory.brain, true)).toBeUndefined();
    expect(verifyPrivateSocketDirectory(directory.dir, "relay.sock", directory.brain, false)).toBeUndefined();
    const socket = await layout(true);
    chownSync(socket.socket, -1, otherGroup!);
    expect(verifyPrivateSocketDirectory(socket.dir, "relay.sock", socket.brain, true)).toBeUndefined();
    expect(conformingPrivateSocket(lstatSync(socket.socket), true)).toBe(false);
  });
});

describe("createPrivateSocketDirectory and securePrivateSocket", () => {
  for (const separate of [false, true]) {
    test(`separate identity ${separate}: the directory and socket get their private modes`, async () => {
      const dir = createPrivateSocketDirectory(join(root(), "brain-relay-"), separate);
      const socket = join(dir, "relay.sock");
      await listen(socket);
      securePrivateSocket(dir, socket, separate);
      expect(lstatSync(dir).mode & 0o7777).toBe(dirMode(separate));
      expect(lstatSync(socket).mode & 0o7777).toBe(sockMode(separate));
      expect(lstatSync(dir).uid).toBe(process.getuid!());
      expect(lstatSync(dir).gid).toBe(process.getgid!());
    });

    test(`separate identity ${separate}: a failure before the socket is bound removes the directory`, () => {
      const dir = createPrivateSocketDirectory(join(root(), "brain-relay-"), separate);
      expect(existsSync(dir)).toBe(true);
      expect(() => securePrivateSocket(dir, join(dir, "relay.sock"), separate)).toThrow();
      expect(existsSync(dir)).toBe(false);
    });
  }
});

describe("launcher call sites refuse a widened directory with their own error", () => {
  const command = (brain: string, extra: object) => workerCommand({ brainPath: brain, command: [process.execPath], env: {}, ...extra } as Parameters<typeof workerCommand>[0]);

  test("the inference relay (restricted envelope)", async () => {
    const f = await layout(false);
    expect(() => command(f.brain, { restricted: { readPaths: [], inferenceDir: f.dir } })).not.toThrow();
    chmodSync(f.dir, 0o701);
    expect(() => command(f.brain, { restricted: { readPaths: [], inferenceDir: f.dir } }))
      .toThrow("the inference relay requires its private directory and server-owned socket");
  });

  test("the provider relay and the module GitHub relay (maintenance envelope)", async () => {
    const f = await layout(false);
    const github = join(f.base, "github");
    mkdirSync(github); chmodSync(github, 0o700);
    await listen(join(github, "github.sock")); chmodSync(join(github, "github.sock"), 0o600);
    const maintenance = (extra: object) => ({ maintenance: { network: false, credentials: true, readPaths: [process.execPath], ...extra } });
    expect(() => command(f.brain, maintenance({ providerRelay: f.dir, githubRelay: github }))).not.toThrow();
    chmodSync(f.dir, 0o701);
    expect(() => command(f.brain, maintenance({ providerRelay: f.dir })))
      .toThrow("the provider relay requires its private server-owned directory and socket");
    chmodSync(github, 0o701);
    expect(() => command(f.brain, maintenance({ githubRelay: github })))
      .toThrow("the module GitHub relay requires its private server-owned directory and socket");
  });

  test("the egress proxy, whose non-conforming provider-relay socket withholds the relay", async () => {
    const base = root(), brain = join(base, "brain"), proxyDir = join(base, "proxy");
    mkdirSync(brain); mkdirSync(proxyDir); chmodSync(proxyDir, 0o700);
    await listen(join(proxyDir, "proxy.sock")); chmodSync(join(proxyDir, "proxy.sock"), 0o600);
    const relay = join(proxyDir, PROVIDER_RELAY_SOCKET_NAME);
    await listen(relay); chmodSync(relay, 0o600);
    const sandbox = { brain, restricted: false, profile: "strict", areas: [], scratchAliasesRemoved: [], readPaths: [process.execPath] };
    const egress = () => command(brain, { sandbox, egress: { proxyDir } });
    expect(egress().join("\n")).toContain("BRAIN_PROVIDER_RELAY_SOCKET");
    chmodSync(relay, 0o666);
    expect(egress().join("\n")).not.toContain("BRAIN_PROVIDER_RELAY_SOCKET");
    chmodSync(proxyDir, 0o701);
    expect(egress).toThrow("egress transport requires its private server-owned proxy directory and socket");
  });
});
