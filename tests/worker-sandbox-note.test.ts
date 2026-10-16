import { createFixtureMaintenanceHost } from "../packages/ui-sdk/tests/helpers/worker-startup-view-fixture.js";
import { installFixtureNativeStartupViews } from "../packages/ui-server/tests/helpers/fixture-native-startup.js";
installFixtureNativeStartupViews();
/**
 * The sandbox note is one text, generated once per worker from its resolved
 * sandbox, and both backends hand the agent exactly that text in owned new-tail
 * context (#1654, #2047). The
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
let maintenance: ReturnType<typeof createFixtureMaintenanceHost>;
const restore: Array<() => void> = [];

beforeEach(() => {
  // Outside /tmp: a worker's /tmp is its own, and a home below it is refused.
  mkdirSync(resolve("tmp"), { recursive: true });
  root = mkdtempSync(join(resolve("tmp"), "worker-sandbox-note-"));
  brain = join(root, "brain"); home = join(root, "home");
  mkdirSync(join(brain, ".brain/scratch"), { recursive: true }); mkdirSync(join(brain, "workspaces")); mkdirSync(home);
  writeFileSync(join(brain, ".gitignore"), ".brain/scratch/\n");
  writeFileSync(join(brain, "ithaca.md"), "# Ithaca\n");
  maintenance = createFixtureMaintenanceHost(brain);
  for (const [key, value] of [["HOME", home], ["PI_CODING_AGENT_DIR", join(root, "agent")]] as const) {
    const previous = process.env[key];
    process.env[key] = value;
    restore.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
});
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  maintenance.cleanup();
  rmSync(root, { recursive: true, force: true });
});

/** The note for this brain and home, from the generator itself. */
function expectedNote(extra: worker.WorkerNoteLimit[] = [], sandbox?: worker.WorkerSandbox): string {
  // Its limits list comes from the same resolved plan each launch applies (#1660).
  const resolved = sandbox ?? worker.prepareWorkerSandbox(brain, { home, maintenance });
  return [worker.workerSandboxNote(resolved,
    { limits: [...worker.workerNoteLimits(worker.launchLimits({}).status), ...extra, worker.outputStagingLimit()] }),
    worker.workerCommandPolicyNote(resolved.commandPolicy, []), worker.workerOutwardNote()].filter(Boolean).join("\n\n");
}

async function claudeContext(sandbox?: worker.WorkerSandbox): Promise<{ append: string; text: string }> {
  sandbox ??= worker.prepareWorkerSandbox(brain, { home, maintenance });
  const turn = createClaudeSdkTurn({
    backend: { brainPath: brain } as never,
    req: { ...(sandbox ? { workerSandbox: sandbox } : {}), prompt: "Return to Ithaca", turnBudgetMs: 180_000, bridge: {}, client: undefined } as never,
    profile: { requiredEnvKeys: [], buildEnv: () => ({ HOME: home }) } as never,
    abortController: new AbortController(), allowedTools: [], confirmPatterns: [],
    turnLock: { acquire: () => undefined, release: () => undefined } as never,
    log: () => undefined,
  });
  try {
    const fixed = turn.options.systemPrompt as { type: string; append: string };
    expect(fixed.type).toBe("preset");
    const messages = typeof turn.prompt === "string" ? turn.prompt : JSON.stringify(await Array.fromAsync(turn.prompt));
    // Decode the SDK content instead of comparing a JSON-escaped wire string.
    const text = typeof turn.prompt === "string" ? messages : JSON.parse(messages)[0].message.content;
    expect(text).toStartWith("Return to Ithaca\n\n[Host context");
    return { append: fixed.append, text };
  } finally { await turn.finishWorker(); }
}

/** The note pi's server side sends its worker, captured at the launch it would have made. */
async function piTurnContext(sandbox?: worker.WorkerSandbox): Promise<{ note: string; text: string }> {
  sandbox ??= worker.prepareWorkerSandbox(brain, { home, maintenance });
  let received: { sandboxNote?: string } | undefined;
  let text: string | undefined;
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
      if (message.type === "prompt") {
        text = message.text;
        sendPipe(stdout, { type: "done", cost: 0 });
      }
      callback();
    } });
    return { stdin, stdout, stderr, exited: exited.promise, kill: stop, limitReport: () => ({ hits: [], fatal: false }) } as unknown as ReturnType<typeof worker.launchAgentWorker>;
  });
  try {
    mkdirSync(join(root, "sessions"), { recursive: true });
    const opened = await openPiWorkerSession({ brainPath: brain }, join(root, "sessions"), { caps, workerStartupView: maintenance.startupView, ...(sandbox ? { workerSandbox: sandbox } : {}) });
    await opened.session.prompt("Return to Ithaca");
    expect(launch).toHaveBeenCalledTimes(1);
  } finally {
    for (const stop of stops) stop();
    launch.mockRestore(); probe.mockRestore();
  }
  expect(received?.sandboxNote).toBeString();
  expect(text).toStartWith("Return to Ithaca\n\n[Host context");
  return { note: received!.sandboxNote!, text: text! };
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

test("both backends deliver the exact generated note only in owned new-tail context", async () => {
  const allowance = worker.resolveTurnTempLimits({}).allowanceBytes;
  const note = expectedNote([worker.turnTempLimit(allowance, "turn_temp")]);
  expect(note).toContain("**Profile: `strict`.**");
  // Claude's note also states its runtime-state allowance (#1625), a fact only
  // that backend has; the generator and the rest of the text are the same.
  const claudeNote = expectedNote([workerStateLimit(worker.resolveWorkerStateLimits({})),
    worker.turnTempLimit(allowance, TURN_TEMP_TOOL_NAME)]);
  expect(claudeNote).toContain("- **Runtime state: 64 MiB.**");
  for (const generated of [note, claudeNote]) expect(generated).toContain("- **Turn temp: 256 MiB.**");
  const claude = await claudeContext();
  expect(claude.text, "CLAUDE_EXACT_NEW_TAIL_NOTE").toContain(`sandbox: ${claudeNote}\ncapabilities:`);
  expect(claude.append, "CLAUDE_LIVE_NOTE_OUTSIDE_APPEND").not.toContain("# Where files go in this turn");
  const sent = await piTurnContext();
  expect(sent.note, "PI_INIT_NOTE").toBe(note);
  expect(sent.text, "PI_EXACT_NEW_TAIL_NOTE").toContain(`sandbox: ${note}\ncapabilities:`);
  const appended = await piSessionAppend(sent.note);
  expect(appended.join("\n"), "PI_LIVE_NOTE_OUTSIDE_APPEND").not.toContain("# Where files go in this turn");
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


test("governed notes reflect admitted host history and exactly the resolved protection, identically in Claude and pi", async () => {
  const sandbox = { ...worker.prepareWorkerSandbox(brain, { home, maintenance }), profile: "governed" as const,
    protection: { paths: [{ rel: "context/policies", reason: "governance rules", mode: "read_only" as const }], ancestors: [] },
    noteFacts: { history: { journal: true, userRevert: true } } };
  const note = worker.workerSandboxNote(sandbox);
  expect(note, "GOVERNED_ADMITTED_JOURNAL_NOTE").toContain("Host change journaling is active for this turn.");
  expect(note).toContain("Only observed raw versions are retained");
  expect(note).toContain("changed paths are skipped as conflicts");
  expect(note).toContain("Only the authenticated user can trigger history restoration");
  expect(note).toContain("- `context/policies`: governance rules (read-only).");
  const moved = worker.workerSandboxNote({ ...sandbox, protection: { paths: [{rel:"notes/athena.md",reason:"policy-selected protection",mode:"absent"}], ancestors: [] } });
  expect(moved,"GOVERNED_RESOLVED_PROTECTION_CHANGED").toContain("- `notes/athena.md`: policy-selected protection (quarantined if created).");
  expect(moved).not.toContain("- `context/policies`: governance rules");
  const allowance = worker.resolveTurnTempLimits({}).allowanceBytes;
  const piNote = expectedNote([worker.turnTempLimit(allowance,"turn_temp")], sandbox);
  const claudeNote = expectedNote([workerStateLimit(worker.resolveWorkerStateLimits({})),worker.turnTempLimit(allowance,TURN_TEMP_TOOL_NAME)], sandbox);
  const claude = await claudeContext(sandbox);
  expect(claude.text,"GOVERNED_CLAUDE_INJECTS_RESOLVED_NOTE").toContain(`sandbox: ${claudeNote}\ncapabilities:`);
  expect(claude.append).not.toContain("Host change journaling is active for this turn.");
  const sent = await piTurnContext(sandbox); expect(sent.note,"GOVERNED_PI_INIT_RESOLVED_NOTE").toBe(piNote);
  expect(sent.text,"GOVERNED_PI_INJECTS_RESOLVED_NOTE").toContain(`sandbox: ${piNote}\ncapabilities:`);
  expect((await piSessionAppend(sent.note)).join("\n"),"GOVERNED_PI_LIVE_NOTE_OUTSIDE_APPEND").not.toContain("Host change journaling is active for this turn.");
  const absent = worker.workerSandboxNote({ ...sandbox, noteFacts: undefined });
  expect(absent,"GOVERNED_STANDALONE_NO_HISTORY_PROMISE").not.toContain("Host change journaling is active");
  expect(absent).toContain("availability was not supplied");
  const voice = worker.workerSandboxNote({ ...sandbox, noteFacts: { history: {journal:true,userRevert:false} } });
  expect(voice).toContain("Host change journaling is active");expect(voice).toContain("User history restoration is unavailable for this turn");expect(voice).not.toContain("User history can revert");
  const noJournal = worker.workerSandboxNote({ ...sandbox, noteFacts: {history:{journal:false,userRevert:true}} });
  expect(noJournal).toContain("Host change journaling is unavailable");expect(noJournal).not.toContain("User history can revert");
});
