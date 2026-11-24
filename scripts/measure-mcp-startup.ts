import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";

const root = resolve(import.meta.dir, "..");
const corpus = join(root, "packages/core/fixtures/corpus");
const phases = ["context", "import", "database", "moduleTools", "vector", "connect"] as const;
const metrics = ["initializeMs", "toolsListMs", "exitMs", ...phases] as const;
type Sample = Partial<Record<typeof metrics[number], number>>;

/** Read every stdout line as MCP. Any diagnostic on stdout fails the measurement. */
async function probe(cwd: string, env: NodeJS.ProcessEnv, timed: boolean): Promise<Sample> {
  const start = performance.now();
  const child = spawn(process.execPath, ["node_modules/.bin/brain", "mcp"], {
    cwd, env: { ...env, NODE_DEBUG: timed ? "brain-mcp-startup" : "" }, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const send = (frame: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
  const sample: Sample = {};
  let initialized = 0, closing = 0;
  try {
    const lines = createInterface({ input: child.stdout });
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ithaca", version: "1" } } });
    for await (const line of lines) {
      const frame = JSON.parse(line);
      if (frame.jsonrpc !== "2.0" || frame.error) throw Error("Invalid MCP response: " + line);
      if (frame.id === 1 && frame.result?.serverInfo && !initialized) {
        initialized = performance.now();
        sample.initializeMs = initialized - start;
        send({ method: "notifications/initialized" });
        send({ id: 2, method: "tools/list", params: {} });
      } else if (frame.id === 2 && Array.isArray(frame.result?.tools) && initialized && !closing) {
        closing = performance.now();
        sample.toolsListMs = closing - initialized;
        child.stdin.end();
      } else throw Error("Unexpected MCP frame: " + line);
    }
    const [code] = await closed;
    if (code !== 0 || !closing) throw Error("Incomplete MCP startup probe: " + stderr);
    sample.exitMs = performance.now() - closing;
    for (const phase of phases) {
      const match = stderr.match(new RegExp("^BRAIN-MCP-STARTUP [0-9]+: phase " + phase + " ([0-9.e+-]+)$", "m"));
      if (timed !== Boolean(match)) throw Error("Unexpected diagnostic for " + phase);
      if (match) {
        const duration = Number(match[1]);
        if (!Number.isFinite(duration) || duration < 0) throw Error("Invalid diagnostic for " + phase);
        sample[phase] = duration;
      }
    }
    return sample;
  } finally { clearTimeout(watchdog); child.kill(); await closed; }
}

function summarize(samples: Sample[]) {
  return Object.fromEntries(metrics.map(metric => {
    const values = samples.map(sample => sample[metric]!).sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = (values[middle]! + values[Math.floor((values.length - 1) / 2)]!) / 2;
    return [metric, { median, p90: values[Math.ceil(values.length * 0.9) - 1], max: values.at(-1) }];
  }));
}

export async function measureMcpStartup(repetitions: number, verifyQuiet = false) {
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) throw Error("Repetitions must be a positive integer");
  const cold: Sample[] = [], warm: Sample[] = [];
  const built = join(root, "packages/core/dist/cli/brain.js");
  const entry = existsSync(built) ? built : join(root, "packages/core/src/cli/brain.ts");
  for (let i = 0; i < repetitions; i++) {
    const directory = mkdtempSync(join(tmpdir(), "odysseus-mcp-"));
    try {
      const brain = join(directory, "brain"), modules = join(brain, "node_modules");
      cpSync(corpus, brain, { recursive: true });
      mkdirSync(join(modules, ".bin"), { recursive: true });
      symlinkSync(join(root, "node_modules/@schlessera"), join(modules, "@schlessera"));
      symlinkSync(entry, join(modules, ".bin/brain"));
      const env = { HOME: directory, BRAIN_ROOT: brain, PATH: process.env.PATH };
      const index = Bun.spawnSync([process.execPath, "node_modules/.bin/brain", "index", "--force"], { cwd: brain, env, timeout: 60_000 });
      if (index.exitCode !== 0) throw Error(index.stderr.toString());
      cold.push(await probe(brain, env, true));
      warm.push(await probe(brain, env, true));
      if (verifyQuiet) await probe(brain, env, false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  return { repetitions, entry: entry === built ? "dist" : "src", unit: "ms", cold: summarize(cold), warm: summarize(warm) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const { values } = (await import("node:util")).parseArgs({ args, options: {
    json: { type: "boolean" }, repetitions: { type: "string", default: "5" },
  } });
  console.log(JSON.stringify(await measureMcpStartup(Number(values.repetitions)), null, values.json ? undefined : 2));
}
