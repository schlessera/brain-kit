import { spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKER_IDENTITY_CLIENT, WORKER_IDENTITY_FALLBACK, WORKER_IDENTITY_STOP } from "../../src/server/worker-identity-program";
import type { prepareWorkerIdentity } from "../../src/server/worker-identity";

type Broker = ReturnType<typeof prepareWorkerIdentity>;

/**
 * The supervisor's side of the control socket: one reply per connection, after
 * a delay. It logs each operation as it arrives and again just before it answers.
 */
const CONTROL_SERVER = String.raw`
import json, os, socket, sys, time
path, log_path, delay, replies = sys.argv[1], sys.argv[2], float(sys.argv[3]), json.loads(sys.argv[4])
server = socket.socket(socket.AF_UNIX, socket.SOCK_SEQPACKET)
server.bind(path + '.tmp')
server.listen(8)
os.rename(path + '.tmp', path)
while True:
    connection, _ = server.accept()
    operation = json.loads(connection.recv(65537))['operation']
    with open(log_path, 'a') as log: log.write(operation + '\n')
    time.sleep(delay)
    with open(log_path, 'a') as log: log.write(operation + ':answered\n')
    connection.send(json.dumps(replies.get(operation, {'ok': True})).encode())
    connection.close()
`;

/**
 * A stand-in for a separate-UID supervisor's control socket, so the broker's
 * real control client runs against it. It answers after `delayMs` and records
 * each operation it was asked for.
 */
export function identityControl(broker: Broker, options: { delayMs?: number; replies?: Record<string, object> } = {}) {
  const { socket } = JSON.parse(broker.command.at(-1)!) as { socket: string };
  const python = ["/usr/bin/python3", "/bin/python3"].find(existsSync);
  if (!python) throw new Error("system python is required for the identity control stand-in");
  // The log lives outside the broker's directory, which a confirmed close removes.
  const logs = mkdtempSync(join(tmpdir(), "identity-control-")), log = join(logs, "operations");
  const server = Bun.spawn([python, "-I", "-S", "-c", CONTROL_SERVER, socket, log, String((options.delayMs ?? 0) / 1000),
    JSON.stringify(options.replies ?? {})], { env: {}, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const ready = () => {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`identity control stand-in exited before it listened (${server.exitCode ?? server.signalCode})`);
    return existsSync(socket);
  };
  return {
    socket,
    ready,
    /** Wait, bounded, until the socket listens. */
    listening: async () => {
      const deadline = Date.now() + 10_000;
      while (!ready()) {
        if (Date.now() >= deadline) throw new Error("identity control stand-in did not listen within 10 s");
        await Bun.sleep(5);
      }
    },
    operations: () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
    stop: async () => { server.kill("SIGKILL"); await server.exited; rmSync(logs, { recursive: true, force: true }); },
  };
}

/** How many identity-control subprocesses (control client, supervisor stop, fallback cleanup) each spawn form started. */
export function identityControlSpawns() {
  const sync = spyOn(Bun, "spawnSync"), spawn = spyOn(Bun, "spawn");
  const programs = new Set([WORKER_IDENTITY_CLIENT, WORKER_IDENTITY_STOP, WORKER_IDENTITY_FALLBACK]);
  const runs = (calls: unknown[][]) => calls.filter(([command]) => Array.isArray(command) && programs.has(String(command[4]))).length;
  return {
    counts: () => ({ sync: runs(sync.mock.calls), async: runs(spawn.mock.calls) }),
    /** The worker launches (a bootstrap carrying its launch payload) started so far. */
    launches: () => spawn.mock.calls.flatMap(([, options], index) =>
      (options as { env?: Record<string, string> } | undefined)?.env?.BRAIN_WORKER_LAUNCH ? [spawn.mock.results[index]!.value as ReturnType<typeof Bun.spawn>] : []),
    restore: () => { sync.mockRestore(); spawn.mockRestore(); },
  };
}
