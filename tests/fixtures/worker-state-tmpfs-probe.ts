/**
 * Real Claude worker spawns, each with its private size-limited runtime-state
 * tmpfs (#1625). The caller runs this in a private mount namespace with
 * Docker's default 64 MiB `/dev/shm`, which the workers must no longer use.
 * Drives the actual worker spawn, launcher and admission ledger and prints one
 * JSON receipt.
 */
import { mkdirSync, readdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { WorkerStateLimits } from "@schlessera/brain-ui-sdk/internal";
import { createWorkerSpawn } from "../../packages/ui-backend-claude/src/worker-spawn.js";
import { processStateLedger } from "../../packages/ui-backend-claude/src/worker-state-budget.js";

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
const shmBefore = shm().free;

const DEFAULT: WorkerStateLimits = { allowanceBytes: 64 * MiB, budgetBytes: 192 * MiB };
/** A failure the spawn names; absent where it names none. */
const failureOf = (worker: { failure(): { errorClass: string } | undefined }) => worker.failure();

/** One worker turn: a shell standing in for the runtime, with the runtime's own `--resume` argv. */
function turn(script: string, resume?: string, limits = DEFAULT, turnTempLimits?: WorkerStateLimits) {
  const worker = createWorkerSpawn(brain, {}, new AbortController().signal, undefined, undefined, undefined, undefined,
    { limits, ...(turnTempLimits ? { turnTempLimits } : {}) });
  let child: SpawnedProcess | undefined, refused: string | undefined;
  try {
    child = worker.spawn({ command: "/bin/sh", args: ["-c", script, "sh", ...(resume ? [`--resume=${resume}`] : [])],
      cwd: brain, env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: config }, signal: new AbortController().signal });
  } catch (error) { refused = error instanceof Error ? error.message : String(error); }
  let out = "";
  const exited = new Promise<{ code: number | null; signal: string | null }>(done => {
    if (!child) return done({ code: null, signal: null });
    child.on("exit", (code: number | null, signal: string | null) => done({ code, signal }));
    // Launcher failures report an error; copy-out refusals retain the exit and name a failure.
    child.on("error", () => done({ code: null, signal: "worker error" }));
  });
  const drained = new Promise<void>(done => {
    if (!child) return done();
    child.stdout.on("data", (data: Buffer) => { out += data.toString(); });
    child.stdout.on("end", done); child.stdout.on("close", done);
  });
  return { worker, refused,
    async settle() { const exit = await exited; await drained; await worker.finish().catch(() => {}); return { exit, out: out.trim(), failure: failureOf(worker) }; } };
}
const append = (id: string, line: string) => `printf '%s\\n' '${line}' >> "$CLAUDE_CONFIG_DIR/projects/${projectName}/${id}.jsonl" && sleep 1`;
const tail = (id: string) => readFileSync(join(project, `${id}.jsonl`), "utf8").trimEnd().split("\n").at(-1);
const mount = 'stat -f -c "%T %b" "$CLAUDE_CONFIG_DIR"';

const receipt: Record<string, unknown> = { scenario, shmTotal: shm().total };
if (scenario === "contend") {
  // An explicit budget of one allowance: fewer workers than the session cap.
  const one: WorkerStateLimits = { allowanceBytes: 64 * MiB, budgetBytes: 64 * MiB };
  session(TROY, 30); session(ITHACA, 30);
  const first = turn(append(TROY, "{\"text\":\"The horse is inside the walls\"}"), TROY, one);
  await Bun.sleep(100);
  const second = turn(append(ITHACA, "{\"text\":\"Home at last\"}"), ITHACA, one);
  receipt.secondRefused = second.refused; receipt.secondClass = failureOf(second.worker)?.errorClass;
  receipt.heldDuringFirst = processStateLedger().held;
  receipt.first = await first.settle();
  const again = turn(append(ITHACA, "{\"text\":\"Home at last\"}"), ITHACA, one);
  receipt.againRefused = again.refused ?? null;
  receipt.again = await again.settle();
  receipt.tails = [tail(TROY), tail(ITHACA)];
} else if (scenario === "fit") {
  // Two 30 MiB conversations at once: impossible on a shared 64 MiB /dev/shm.
  session(AEAEA, 30); session(OGYGIA, 30);
  const a = turn(`${mount}; ${append(AEAEA, "{\"text\":\"Circe\"}")}`, AEAEA);
  const b = turn(`${mount}; ${append(OGYGIA, "{\"text\":\"Calypso\"}")}`, OGYGIA);
  receipt.refused = [a.refused ?? null, b.refused ?? null];
  receipt.held = processStateLedger().held;
  receipt.results = await Promise.all([a.settle(), b.settle()]);
  receipt.tails = [tail(AEAEA), tail(OGYGIA)];
} else if (scenario === "grow") {
  session(TROY, 30);
  // Holds a 30 MiB conversation while the other turn grows.
  const holder = turn(`sleep 2; ${append(TROY, "{\"text\":\"Still at Troy\"}")}`, TROY);
  await Bun.sleep(100);
  // A new conversation that grows 4 MiB at a time, far past its allowance.
  const grower = turn(`d="$CLAUDE_CONFIG_DIR/projects/${projectName}"; mkdir -p "$d"; i=0; while [ $i -lt 30 ]; do head -c ${4 * MiB} /dev/zero >> "$d/${VOYAGE}.jsonl" 2>/dev/null || { echo full-at-$i; break; }; i=$((i+1)); done`);
  receipt.grower = await grower.settle();
  receipt.holder = await holder.settle();
  receipt.holderTail = tail(TROY);
  receipt.grownSaved = readFileSync(join(project, `${VOYAGE}.jsonl`)).length;
} else if (scenario === "override") {
  // An 8 MiB allowance: the actual mount, the size refusal and the copy bound all follow it.
  const small: WorkerStateLimits = { allowanceBytes: 8 * MiB, budgetBytes: 16 * MiB };
  session(TROY, 10); session(ITHACA, 4);
  const tooLarge = turn(append(TROY, "{\"text\":\"never\"}"), TROY, small);
  receipt.tooLargeRefused = tooLarge.refused;
  receipt.tooLargeClass = failureOf(tooLarge.worker)?.errorClass ?? null;
  const fits = turn(`${mount}; head -c ${8 * MiB} /dev/zero > "$CLAUDE_CONFIG_DIR/flood" 2>/dev/null; echo flood=$?`, ITHACA, small);
  receipt.fits = await fits.settle();
} else if (scenario === "planted") {
  // The worker plants links in its own runtime state while it runs. The
  // server copies out only after its namespace is gone, and refuses them.
  const victim = join(root, "victim.txt");
  writeFileSync(victim, "Penelope's loom\n");
  const plants: Record<string, string> = {
    symlink: `ln -s "${victim}" "$d/${VOYAGE}.jsonl"`,
    hardlink: `printf x > "$d/a.jsonl"; ln "$d/a.jsonl" "$d/${VOYAGE}.jsonl"`,
    "symlinked directory": `ln -s "${project}" "$d/${VOYAGE}"`,
    // A regular transcript first, swapped for a link by a background process before the worker exits.
    "late swap": `printf '{}\\n' > "$d/${VOYAGE}.jsonl"; (sleep 0.2; rm "$d/${VOYAGE}.jsonl"; ln -s "${victim}" "$d/${VOYAGE}.jsonl") & sleep 0.5`,
  };
  const outcomes: Record<string, unknown> = {};
  for (const [name, plant] of Object.entries(plants)) {
    const t = turn(`d="$CLAUDE_CONFIG_DIR/projects/${projectName}"; mkdir -p "$d"; ${plant}; echo planted`);
    let error: string | null = null;
    const settled = await t.settle();
    await t.worker.finish().catch(e => { error = e instanceof Error ? e.message : String(e); });
    outcomes[name] = { ...settled, error, savedEntries: readdirSync(project).sort() };
  }
  // Full and planted: the exhaustion is named, and its message does not claim a refused copy-out kept anything.
  const both = turn(`d="$CLAUDE_CONFIG_DIR/projects/${projectName}"; mkdir -p "$d"; ln -s "${victim}" "$d/${VOYAGE}.jsonl"; head -c ${70 * MiB} /dev/zero > "$CLAUDE_CONFIG_DIR/flood" 2>/dev/null; echo planted`);
  const bothSettled = await both.settle();
  outcomes["full and planted"] = { ...bothSettled, savedEntries: readdirSync(project).sort(),
    error: await both.worker.finish().then(() => null, e => e instanceof Error ? e.message : String(e)) };
  receipt.outcomes = outcomes;
  receipt.victim = readFileSync(victim, "utf8");
} else if (scenario === "turn-temp") {
  // Turn temp (#1703): each worker's /tmp is a private tmpfs of its own
  // allowance, admitted in the same ledger as runtime state.
  const one: WorkerStateLimits = { allowanceBytes: 8 * MiB, budgetBytes: 8 * MiB };
  session(TROY, 1); session(ITHACA, 1);
  const flood = 'stat -f -c "%T %b %S" /tmp; dd if=/dev/zero of=/tmp/flood bs=1M count=32; echo "dd=$?"; '
    + 'stat -f -c "free=%a" /tmp; sleep 1; ' + append(TROY, "{\"text\":\"Scylla\"}");
  const first = turn(flood, TROY, DEFAULT, one);
  await Bun.sleep(200);
  receipt.turnTempHeldDuringFirst = processStateLedger().turnTempHeld;
  receipt.stateHeldDuringFirst = processStateLedger().held;
  const second = turn(append(ITHACA, "{\"text\":\"Charybdis\"}"), ITHACA, DEFAULT, one);
  receipt.secondRefused = second.refused ?? null; receipt.secondClass = failureOf(second.worker)?.errorClass ?? null;
  // A refusal holds nothing, runtime state included.
  receipt.heldAfterRefusal = { state: processStateLedger().held, turnTemp: processStateLedger().turnTempHeld };
  receipt.first = await first.settle();
  const again = turn(append(ITHACA, "{\"text\":\"Charybdis\"}"), ITHACA, DEFAULT, one);
  receipt.againRefused = again.refused ?? null;
  receipt.again = await again.settle();
  receipt.tails = [tail(TROY), tail(ITHACA)];
} else if (scenario === "crash") {
  // The test kills this server process mid-turn; the worker must not outlive it.
  session(TROY, 4);
  const marker = process.argv[4]!;
  turn(`echo ready; sleep 30 # ${marker}`, TROY);
  console.log(JSON.stringify({ scenario, ready: true }));
  await Bun.sleep(60_000);
}
receipt.heldAfter = processStateLedger().held + processStateLedger().turnTempHeld;
receipt.shmUnchanged = shm().free === shmBefore;
receipt.shmLeftover = readdirSync("/dev/shm").filter(name => name.startsWith("brain-claude-state-")).length;
console.log(JSON.stringify(receipt));
