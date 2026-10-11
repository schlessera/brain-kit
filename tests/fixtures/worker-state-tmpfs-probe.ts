/**
 * Real workers on a real 64 MiB `/dev/shm` (#1625). The caller mounts that
 * tmpfs in a private mount namespace; this drives the actual worker spawn,
 * launcher and ledger against it and prints one JSON receipt.
 */
import { mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { createWorkerSpawn } from "../../packages/ui-backend-claude/src/worker-spawn.js";

const [scenario, root] = process.argv.slice(2) as [string, string];
const MiB = 1024 * 1024;
const TROY = "11111111-1111-4111-8111-111111111111";
const ITHACA = "22222222-2222-4222-8222-222222222222";
const AEAEA = "33333333-3333-4333-8333-333333333333";
const OGYGIA = "44444444-4444-4444-8444-444444444444";
const VOYAGE = "55555555-5555-4555-8555-555555555555";
const brain = join(root, "brain"), config = join(root, "claude");
mkdirSync(brain); mkdirSync(config);
const projectName = brain.replace(/[^a-zA-Z0-9]/g, "-");
const project = join(config, "projects", projectName);
mkdirSync(project, { recursive: true });
writeFileSync(join(config, "settings.json"), "{}");
const session = (id: string, mib: number) => writeFileSync(join(project, `${id}.jsonl`), "{\"type\":\"user\"}\n".repeat(Math.floor(mib * MiB / 16)));
const shm = () => { const s = statfsSync("/dev/shm"); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; };
let lowest = shm().free;
const watch = setInterval(() => { lowest = Math.min(lowest, shm().free); }, 10);

/** The spawn's named worker-state failure; absent where the spawn names none. */
const failureOf = (worker: object) => (worker as { failure?: () => { errorClass: string } | undefined }).failure?.();

/** One worker turn: a shell standing in for the runtime, with the runtime's own `--resume` argv. */
function turn(script: string, resume?: string) {
  const worker = createWorkerSpawn(brain, {}, new AbortController().signal, undefined, {}, 50);
  let child: SpawnedProcess | undefined, refused: string | undefined;
  try {
    child = worker.spawn({ command: "/bin/sh", args: ["-c", script, "sh", ...(resume ? ["--resume", resume] : [])],
      cwd: brain, env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: config }, signal: new AbortController().signal });
  } catch (error) { refused = error instanceof Error ? error.message : String(error); }
  const exited = new Promise<{ code: number | null; signal: string | null }>(done => {
    if (!child) return done({ code: null, signal: null });
    child.on("exit", (code: number | null, signal: string | null) => done({ code, signal }));
  });
  if (child) child.stdout.resume();
  return { worker, refused,
    async settle() { const exit = await exited; await worker.finish().catch(() => {}); return { exit, failure: failureOf(worker) }; } };
}
const append = (id: string, line: string) => `printf '%s\\n' '${line}' >> "$CLAUDE_CONFIG_DIR/projects/${projectName}/${id}.jsonl" && sleep 1`;
const tail = (id: string) => readFileSync(join(project, `${id}.jsonl`), "utf8").trimEnd().split("\n").at(-1);

const receipt: Record<string, unknown> = { scenario, total: shm().total };
if (scenario === "contend") {
  session(TROY, 30); session(ITHACA, 30);
  const first = turn(append(TROY, "{\"text\":\"The horse is inside the walls\"}"), TROY);
  await Bun.sleep(100);
  const second = turn(append(ITHACA, "{\"text\":\"Home at last\"}"), ITHACA);
  receipt.secondRefused = second.refused; receipt.secondClass = failureOf(second.worker)?.errorClass;
  receipt.first = await first.settle();
  const again = turn(append(ITHACA, "{\"text\":\"Home at last\"}"), ITHACA);
  receipt.againRefused = again.refused ?? null;
  receipt.again = await again.settle();
  receipt.tails = [tail(TROY), tail(ITHACA)];
} else if (scenario === "fit") {
  session(AEAEA, 5); session(OGYGIA, 5);
  const a = turn(append(AEAEA, "{\"text\":\"Circe\"}"), AEAEA);
  const b = turn(append(OGYGIA, "{\"text\":\"Calypso\"}"), OGYGIA);
  receipt.refused = [a.refused ?? null, b.refused ?? null];
  receipt.results = await Promise.all([a.settle(), b.settle()]);
  receipt.tails = [tail(AEAEA), tail(OGYGIA)];
} else if (scenario === "grow") {
  session(TROY, 30);
  // Holds 30 MiB of history plus its headroom while the other turn grows.
  const holder = turn("sleep 4", TROY);
  await Bun.sleep(100);
  // A new conversation that grows 1 MiB every 100 ms, far past its 16 MiB headroom.
  const grower = turn(`d="$CLAUDE_CONFIG_DIR/projects/${projectName}"; mkdir -p "$d"; i=0; while [ $i -lt 60 ]; do head -c 1048576 /dev/zero >> "$d/${VOYAGE}.jsonl" || { echo ENOSPC-HIT >&2; exit 9; }; i=$((i+1)); sleep 0.1; done`);
  receipt.grower = await grower.settle();
  receipt.holder = await holder.settle();
}
clearInterval(watch);
receipt.lowestFree = lowest;
receipt.leftover = (await Array.fromAsync(new Bun.Glob("brain-claude-state-*").scan({ cwd: "/dev/shm", onlyFiles: false }))).length;
console.log(JSON.stringify(receipt));
