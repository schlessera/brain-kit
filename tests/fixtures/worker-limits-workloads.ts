/**
 * The four first-party workloads under the default worker limits (#1660),
 * run by tests/worker-limits-workloads.test.ts behind an offline network
 * namespace with loopback fixture inference only.
 *
 * Each runs through the real launcher and bubblewrap with the host's default
 * limits: a Claude Code turn and a pi turn that each run one shell tool, a
 * `brain index` of the fixture corpus, and a Chromium render through
 * `brain render`. Peak resident memory comes from the kernel's rusage of the
 * workload's process tree, measured inside the worker. Prints one JSON line.
 *
 * Usage: bun worker-limits-workloads.ts <root> <claude-binary> [chromium]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchFixtureAgentWorker as launchAgentWorker } from "../../packages/ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { formatLimit, workerLimitsPlan } from "../../packages/ui-sdk/src/server/worker-limits";

const [root, claude, chromium] = process.argv.slice(2) as [string, string, string | undefined];
const REPO = resolve(import.meta.dir, "../..");
const CORPUS = join(REPO, "packages/core/fixtures/corpus");
const BRAIN_CLI = join(REPO, "packages/core/src/cli/brain.ts");
const PI_CLI = join(REPO, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

/** Runs argv, sends its output to stderr, then prints the tree's peak rusage as one JSON line. */
const MEASURE = `import json, resource, subprocess, sys, time
start = time.time()
code = subprocess.run(sys.argv[1:], stdout=sys.stderr).returncode
usage = resource.getrusage(resource.RUSAGE_CHILDREN)
print(json.dumps({"exit": code, "peakRssBytes": usage.ru_maxrss * 1024, "seconds": round(time.time() - start, 2)}))`;

const brainPath = join(root, "brain");
mkdirSync(brainPath, { recursive: true });
writeFileSync(join(brainPath, "odysseus.md"), "Odysseus counts the oars.\n");
// The host's defaults, exactly as a turn gets them.
const plan = workerLimitsPlan();

/** Loopback Anthropic Messages fixture: one shell tool call, then an answer. */
let calls = 0;
const inference = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (new URL(request.url).pathname !== "/v1/messages") return Response.json({});
  calls++;
  const body = await request.json() as { tools?: Array<{ name: string }>; messages?: unknown[] };
  const tools = body.tools?.map(t => t.name) ?? [];
  const shell = tools.includes("Bash") ? "Bash" : tools.includes("bash") ? "bash" : undefined;
  const history = JSON.stringify(body.messages ?? []);
  const tool = shell && !history.includes("tool_result") && !history.includes("toolResult");
  const events: unknown[] = [{ type: "message_start", message: { id: `msg_${calls}`, type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } }];
  if (tool) events.push(
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${calls}`, name: shell, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "ls / | wc -l" }) } },
    { type: "content_block_stop", index: 0 });
  else events.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Odysseus counted the oars." } },
    { type: "content_block_stop", index: 0 });
  events.push({ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" });
  return new Response(events.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
const url = `http://127.0.0.1:${inference.port}`;

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let output = "";
  for await (const chunk of stream as AsyncIterable<Buffer>) output += chunk.toString();
  return output;
}

async function workload(command: string[], env: Record<string, string> = {}) {
  const python = Bun.which("python3");
  if (!python) throw new Error("python3 is required to measure the workloads");
  const worker = launchAgentWorker({ brainPath, limits: plan, command: [python, "-c", MEASURE, ...command],
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/tmp", ...env } });
  worker.stdin.end();
  const [code, stdout, stderr] = await Promise.all([worker.exited, collect(worker.stdout), collect(worker.stderr)]);
  const measured = JSON.parse(stdout.trim().split("\n").at(-1) || "null") as { exit: number; peakRssBytes: number; seconds: number } | null;
  return { code, ...measured, ...(measured ? { peakRss: formatLimit("memory", measured.peakRssBytes) } : {}),
    limitHits: worker.limitReport().hits, answered: stderr.includes("Odysseus counted the oars."), stderr: stderr.slice(-1500) };
}

/**
 * The corpus copied into the worker's own scratch tmpfs, resolving the
 * repository's packages. Not `/tmp`: the worker's `/tmp` tmpfs covers a
 * read-only `/tmp`, and the CLI's read-only check reads the covered one (#1689).
 */
const corpus = `cp -r ${CORPUS} "$BRAIN_WORKER_SCRATCH/corpus" && ln -s ${REPO}/node_modules "$BRAIN_WORKER_SCRATCH/node_modules" && cd "$BRAIN_WORKER_SCRATCH/corpus"`;
const models = JSON.stringify({ providers: { anthropic: { baseUrl: url, apiKey: "offline-fixture" } } });

try {
  const results = {
    "claude-turn": await workload([claude, "-p", "Odysseus counts the oars", "--output-format", "json", "--model", "claude-sonnet-4-6",
      "--max-turns", "3", "--dangerously-skip-permissions"],
    { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "offline-fixture", CLAUDE_CONFIG_DIR: "/tmp/claude", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }),
    "pi-turn": await workload(["/bin/sh", "-c", `mkdir -p /tmp/pi && printf '%s' '${models}' > /tmp/pi/models.json && exec ${process.execPath} ${PI_CLI}`
      + " -p --no-session --no-extensions --no-skills --provider anthropic --model claude-sonnet-4-6 --thinking off 'Odysseus counts the oars'"],
    { PI_CODING_AGENT_DIR: "/tmp/pi", PI_OFFLINE: "1" }),
    "brain-index": await workload(["/bin/sh", "-c", `${corpus} && ${process.execPath} ${BRAIN_CLI} index --json`]),
    ...(chromium ? { "chromium-render": await workload(["/bin/sh", "-c",
      `${corpus} && ${process.execPath} ${BRAIN_CLI} render _index.md --format png --out _index.png --json && test -s _index.png`],
    { PUPPETEER_EXECUTABLE_PATH: chromium }) } : {}),
  };
  console.log(JSON.stringify({ limits: plan.status, inferenceCalls: calls, results }));
} finally { inference.stop(true); }
