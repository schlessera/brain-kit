/**
 * The sandbox note is one text, generated once per worker from its resolved
 * sandbox, and both backends hand the agent exactly that text (#1654). The
 * brain CLI's read-only refusal repeats the note's rule rather than its own
 * wording, because both render it from brain-common's worker-areas rules.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { linkRule, READ_ONLY_BRAIN_RULE, TURN_TEMP_RULE } from "@schlessera/brain-common/internal/worker-areas";
import * as worker from "@schlessera/brain-ui-sdk/internal";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { readOnlyBrainError } from "../packages/core/src/cli/read-only.js";
import { createClaudeSdkTurn } from "../packages/ui-backend-claude/src/sdk-options.js";
import { workerStateLimit } from "../packages/ui-backend-claude/src/worker-state.js";
import { TURN_TEMP_TOOL_NAME } from "../packages/ui-backend-claude/src/turn-temp-tool.js";
import { createBrainAccess } from "../packages/ui-backend-pi/src/brain-access.js";
import { createSessionResources } from "../packages/ui-backend-pi/src/session-resources.js";
import { toolLockFromKeyed } from "../packages/ui-backend-pi/src/tools.js";
import { openPiWorkerSession } from "../packages/ui-backend-pi/src/worker-session.js";
import { sendPipe } from "../packages/ui-backend-pi/src/worker-protocol.js";

const caps = { askUser: false, askUserList: false, askUserRank: false, location: false, activity: false, mask: false, turnTemp: true };
let root: string, brain: string, home: string;
const restore: Array<() => void> = [];

beforeEach(() => {
  // Outside /tmp: a worker's /tmp is its own, and a home below it is refused.
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(join(resolve("tmp"), "worker-sandbox-note-"));
  brain = join(root, "brain"); home = join(root, "home");
  mkdirSync(join(brain, ".brain/scratch"), { recursive: true }); mkdirSync(join(brain, "workspaces")); mkdirSync(home);
  writeFileSync(join(brain, ".gitignore"), ".brain/scratch/\n");
  writeFileSync(join(brain, "ithaca.md"), "# Ithaca\n");
  for (const [key, value] of [["HOME", home], ["PI_CODING_AGENT_DIR", join(root, "agent")]] as const) {
    const previous = process.env[key];
    process.env[key] = value;
    restore.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
});
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  rmSync(root, { recursive: true, force: true });
});

/** The note for this brain and home, from the generator itself. */
function expectedNote(extra: worker.WorkerNoteLimit[] = []): string {
  // Its limits list comes from the same resolved plan each launch applies (#1660).
  return worker.workerSandboxNote(worker.prepareWorkerSandbox(brain, { home }),
    { limits: [...worker.workerNoteLimits(worker.launchLimits({}).status), ...extra] });
}

function claudeAppend(): string {
  const { options } = createClaudeSdkTurn({
    backend: { brainPath: brain } as never,
    req: { prompt: "Return to Ithaca", turnBudgetMs: 180_000, bridge: {}, client: undefined } as never,
    profile: { requiredEnvKeys: [], buildEnv: () => ({ HOME: home }) } as never,
    abortController: new AbortController(), allowedTools: [], confirmPatterns: [],
    turnLock: { acquire: () => undefined, release: () => undefined } as never,
    log: () => undefined,
  });
  const prompt = options.systemPrompt as { type: string; append: string };
  expect(prompt.type).toBe("preset");
  return prompt.append;
}

/** The note pi's server side sends its worker, captured at the launch it would have made. */
async function piInitNote(): Promise<string> {
  let received: { sandboxNote?: string } | undefined;
  const stops: Array<() => void> = [];
  const probe = spyOn(worker.workerHostBoundary, "probe").mockReturnValue({ ok: true });
  const launch = spyOn(worker, "launchAgentWorker").mockImplementation(() => {
    const stdout = new PassThrough(), stderr = new PassThrough();
    const exited = Promise.withResolvers<number>();
    const stop = () => { stdout.end(); stderr.end(); exited.resolve(0); };
    stops.push(stop);
    const stdin = new Writable({ write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk));
      if (message.type === "init") {
        received = message;
        sendPipe(stdout, { type: "ready", sessionId: message.sessionId, levels: [], cost: 0 });
      }
      callback();
    } });
    return { stdin, stdout, stderr, exited: exited.promise, kill: stop, limitReport: () => ({ hits: [], fatal: false }) } as unknown as ReturnType<typeof worker.launchAgentWorker>;
  });
  try {
    mkdirSync(join(root, "sessions"), { recursive: true });
    await openPiWorkerSession({ brainPath: brain }, join(root, "sessions"), { caps });
    expect(launch).toHaveBeenCalledTimes(1);
  } finally {
    for (const stop of stops) stop();
    launch.mockRestore(); probe.mockRestore();
  }
  expect(received?.sandboxNote).toBeString();
  return received!.sandboxNote!;
}

/** What pi's worker builds its session from that init: the resource loader's system-prompt append. */
async function piSessionAppend(sandboxNote: string): Promise<string[]> {
  const resources = createSessionResources({
    backend: { brainPath: brain, loadExtensions: false }, brain: createBrainAccess(brain),
    lock: toolLockFromKeyed(createKeyedLock()), allowedTools: new Set(), confirmPatterns: [], loadExtensions: false,
    sandboxNote,
  });
  const { loader } = await resources.build(resources.buildToolkit(caps), { caps });
  return loader.getAppendSystemPrompt();
}

test("Claude's system-prompt append and pi's session resources carry the same generated note", async () => {
  const allowance = worker.resolveTurnTempLimits({}).allowanceBytes;
  const note = expectedNote([worker.turnTempLimit(allowance, "turn_temp")]);
  expect(note).toContain("**Profile: `strict`.**");
  // Claude's note also states its runtime-state allowance (#1625), a fact only
  // that backend has; the generator and the rest of the text are the same.
  const claudeNote = expectedNote([workerStateLimit(worker.resolveWorkerStateLimits({})),
    worker.turnTempLimit(allowance, TURN_TEMP_TOOL_NAME)]);
  expect(claudeNote).toContain("- **Runtime state: 64 MiB.**");
  for (const generated of [note, claudeNote]) expect(generated).toContain("- **Turn temp: 256 MiB.**");
  const claude = claudeAppend();
  expect(claude.endsWith(`\n\n${claudeNote}`), "CLAUDE_NOTE").toBe(true);
  const sent = await piInitNote();
  expect(sent, "PI_INIT_NOTE").toBe(note);
  const appended = await piSessionAppend(sent);
  expect(appended.some(part => part.endsWith(`\n\n${note}`) || part === note), "PI_SESSION_NOTE").toBe(true);
});

test("a read-only refusal from the brain CLI repeats the note's rules", () => {
  const note = expectedNote();
  for (const rule of [READ_ONLY_BRAIN_RULE, TURN_TEMP_RULE, linkRule(".brain/scratch")]) expect(note).toContain(rule);
  const add = readOnlyBrainError("add", { code: "EROFS" })!.error.message;
  expect(add, "ADD_RULE").toContain(READ_ONLY_BRAIN_RULE);
  expect(add).toContain("mcp__brain-ui__brain_add");
  // A scratch write route in a hosted worker: the link and turn-temp rules, word for word.
  const render = readOnlyBrainError("render", { code: "EROFS" }, brain)!.error.message;
  expect(render, "RENDER_LINK_RULE").toContain(linkRule(".brain/scratch"));
  expect(render, "RENDER_TURN_TEMP_RULE").toContain(TURN_TEMP_RULE);
});
