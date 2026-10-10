import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";
/**
 * A message sent while a Claude turn runs reaches the model inside that turn
 * (#1003), the way Claude Code itself delivers one typed mid-turn.
 *
 * These run the REAL Claude Code binary the lockfile installs (the Agent SDK's
 * bundled one) through the production backend, against a scripted Messages
 * API on loopback set as `ANTHROPIC_BASE_URL`. The credentials are bogus and
 * nothing leaves the machine. The assertions are on what the CLI actually
 * SENT the model: a scripted reply that "acknowledges" the message would
 * prove nothing, because the script would say it either way.
 *
 * The scenario is a turn of three model steps: an `ask_user` card the test
 * holds open, then a Bash call the confirm patterns send for approval, then a
 * final answer. The follow-up goes in while the card is open, so the step
 * running when it arrives is a real tool call that has not finished.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AskUserQuestion,
  AskUserResult,
  BackendBridge,
  PermissionRequest,
  ServerMessage,
  SessionHistoryMessage,
} from "@schlessera/brain-ui-sdk/server";

import { ASK_USER_TOOL_NAME } from "../src/ask-user-tool";
import { createClaudeBackend } from "../src/backend";

const OAUTH = `sk-ant-oat01-${"o".repeat(95)}AA`;
const LIVE = 90_000;
/** The follow-up's text: distinctive, so finding it in a request is unambiguous. */
const STEER = "Also check the harbour log for Ithaca before you sail.";
const ANSWER = "Ithaca";
const ASK_ID = "toolu_follow_ask";
const BASH_ID = "toolu_follow_bash";
/** A confirm pattern (`brain archive`), so the call needs an approval — which the test denies. */
const BASH_COMMAND = "brain archive notes/odysseus-route.md";

const QUESTIONS = [
  {
    question: "Which island should the crew make for first?",
    header: "Route",
    multiSelect: false,
    options: [
      { label: ANSWER, description: "Home, by the long way round." },
      { label: "Aeaea", description: "Circe's island." },
    ],
  },
];

// ---------------------------------------------------------------------------
// The scripted model
// ---------------------------------------------------------------------------

interface MainRequest {
  /**
   * What the CLI added since the model's last step: every message after the
   * last assistant one. The CLI may put a mid-turn message in a block of the
   * tool-result message or in a message of its own, so both count.
   */
  added: Array<{ role: string; content: unknown }>;
  /** When it arrived, against the frames' clock. */
  at: number;
}

let server: ReturnType<typeof Bun.serve>;
let requests: MainRequest[] = [];
/** Resolves the main request with this index once it arrives; answered when released. */
let holdRequest: { index: number; arrived: () => void; release: Promise<void> } | null = null;
let clock = 0;

function sse(events: unknown[]): Response {
  const body = events
    .map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function messageStart(): unknown {
  return {
    type: "message_start",
    message: {
      id: `msg_${crypto.randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "claude-probe",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  };
}

function textReply(text: string): Response {
  return sse([
    messageStart(),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

function toolReply(id: string, name: string, input: Record<string, unknown>): Response {
  return sse([
    messageStart(),
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/messages") return Response.json({});
      const body = (await req.json()) as {
        tools?: Array<{ name: string }>;
        messages: Array<{ role: string; content: unknown }>;
      };
      // Side requests (titles, classifiers) do not offer the turn's tools.
      if (!(body.tools ?? []).some((tool) => tool.name === ASK_USER_TOOL_NAME)) return textReply("ok");
      const index = requests.length;
      const lastStep = body.messages.findLastIndex((message) => message.role === "assistant");
      requests.push({ added: body.messages.slice(lastStep + 1), at: ++clock });
      if (holdRequest?.index === index) {
        holdRequest.arrived();
        await holdRequest.release;
      }
      if (index === 0) return toolReply(ASK_ID, ASK_USER_TOOL_NAME, { questions: QUESTIONS });
      if (index === 1) return toolReply(BASH_ID, "Bash", { command: BASH_COMMAND, description: "Archive the route note" });
      return textReply(`Final answer ${index}.`);
    },
  });
});

afterAll(() => {
  server.stop(true);
});

// ---------------------------------------------------------------------------
// One turn through the production backend
// ---------------------------------------------------------------------------

const scratch: string[] = [];
const savedEnv = { ...process.env };

afterEach(() => {
  requests = [];
  holdRequest = null;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function arrange(): string {
  const home = tempDir("follow-home-");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const brainPath = tempDir("follow-brain-");
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) delete process.env[key];
  Object.assign(process.env, {
    HOME: home,
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
    CLAUDE_CODE_OAUTH_TOKEN: OAUTH,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    BRAIN_UI_SUBPROCESS_ENV_EXTRA: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  });
  return brainPath;
}

/** What one turn did, on one clock with the model's requests. */
interface Observed {
  frames: Array<{ frame: ServerMessage; at: number }>;
  sdk: SDKMessage[];
  asked: AskUserQuestion[][];
  permissions: PermissionRequest[];
  followUpError: unknown;
  /** The session as the backend replays it after the turn. */
  history: SessionHistoryMessage[];
}

interface Scenario {
  /** When to send the follow-up: while the card is open, or while the final answer is generated. */
  sendDuring: "tool" | "final";
  /**
   * The control: the backend's follow-up is accepted, but the CLI is handed
   * only the turn's first message, as it was before #1003.
   */
  deliveryDisabled?: boolean;
}

/** The real query; the control cuts its input down to the first message. */
function observedQuery(sdk: SDKMessage[], deliveryDisabled: boolean): typeof query {
  return ((params: Parameters<typeof query>[0]) => {
    const prompt = deliveryDisabled ? firstOnly(params.prompt as AsyncIterable<SDKUserMessage>) : params.prompt;
    const real = query({ ...params, prompt });
    return {
      initializationResult: () => real.initializationResult(),
      getSettings: () => (real as unknown as { getSettings(): Promise<unknown> }).getSettings(),
      async *[Symbol.asyncIterator]() {
        for await (const message of real) {
          sdk.push(message);
          yield message;
        }
      },
    };
  }) as unknown as typeof query;
}

async function* firstOnly(prompt: AsyncIterable<SDKUserMessage>): AsyncIterable<SDKUserMessage> {
  const first = await prompt[Symbol.asyncIterator]().next();
  if (!first.done) yield first.value;
}

async function runScenario(scenario: Scenario): Promise<Observed> {
  const brainPath = arrange();
  const observed: Observed = { frames: [], sdk: [], asked: [], permissions: [], followUpError: undefined, history: [] };
  let sessionId: string | undefined;
  let releaseCard!: () => void;
  const cardReleased = new Promise<void>((resolve) => (releaseCard = resolve));
  let cardOpen!: () => void;
  const cardOpened = new Promise<void>((resolve) => (cardOpen = resolve));

  let finalArrived!: () => void;
  const finalRequested = new Promise<void>((resolve) => (finalArrived = resolve));
  let releaseFinal!: () => void;
  if (scenario.sendDuring === "final") {
    holdRequest = { index: 2, arrived: finalArrived, release: new Promise<void>((resolve) => (releaseFinal = resolve)) };
  }

  const bridge: BackendBridge = {
    emit: (frame) => {
      observed.frames.push({ frame, at: ++clock });
      if (frame.type === "session_info") sessionId = frame.sessionId;
    },
    requestPermission: async (request) => {
      observed.permissions.push(request);
      return { behavior: "deny", message: "Not today: the archive stays." };
    },
    askUser: async (_requestId, questions): Promise<AskUserResult> => {
      observed.asked.push(questions);
      cardOpen();
      await cardReleased;
      return { answers: { [questions[0]!.question]: ANSWER } };
    },
  };
  const backend = createClaudeBackend({ brainPath, queryFn: observedQuery(observed.sdk, scenario.deliveryDisabled ?? false), log: () => {} });

  const sendFollowUp = async (): Promise<void> => {
    try {
      await backend.followUp!({ sessionId: sessionId!, prompt: STEER });
    } catch (error) {
      observed.followUpError = error;
    }
    // Give the CLI time to read it before the step completes. A delivering
    // run reports it read; the control never will, so it waits out the bound.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !observed.sdk.some(isQueued)) await Bun.sleep(25);
  };

  const turn = backend.startTurn({ prompt: "Plan the voyage home.", signal: new AbortController().signal, bridge });
  if (scenario.sendDuring === "tool") {
    await cardOpened;
    await sendFollowUp();
    releaseCard();
  } else {
    await cardOpened;
    releaseCard();
    await finalRequested;
    await sendFollowUp();
    releaseFinal();
  }
  await turn;
  observed.history = await backend.getHistory(sessionId!);
  return observed;
}

function isQueued(message: SDKMessage): boolean {
  const frame = message as unknown as { type: string; state?: string };
  return frame.type === "command_lifecycle" && frame.state === "queued";
}

// ---------------------------------------------------------------------------
// What the model was sent
// ---------------------------------------------------------------------------

function blocks(content: unknown): Array<{ type: string; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  return blocks(value)
    .map((block) => (block.type === "text" ? (block.text ?? "") : block.type === "tool_result" ? textOf(block.content) : ""))
    .join("\n");
}

function addedText(request: MainRequest | undefined): string {
  return (request?.added ?? []).map((message) => textOf(message.content)).join("\n");
}

/** The request carries this tool's successful result. */
function carriesResult(request: MainRequest | undefined, toolUseId: string): boolean {
  return (request?.added ?? []).flatMap((message) => blocks(message.content)).some(
    (block) => block.type === "tool_result" && block.tool_use_id === toolUseId && block.is_error !== true
  );
}

function resultFrames(observed: Observed) {
  return observed.frames.filter(({ frame }) => frame.type === "result");
}

/**
 * The acceptance criterion's assertion: the request right after the tool the
 * follow-up arrived during carries that tool's successful result AND the
 * follow-up's text, and it went out before the turn's terminal result.
 */
function deliveredInTurn(observed: Observed): boolean {
  const next = requests[1];
  const terminal = resultFrames(observed)[0];
  return (
    next !== undefined &&
    carriesResult(next, ASK_ID) &&
    addedText(next).includes(STEER) &&
    terminal !== undefined &&
    next.at < terminal.at
  );
}

describe("a follow-up sent while a tool runs (#1003)", () => {
  test("reaches the model beside that tool's result, inside the running turn", async () => {
    const observed = await runScenario({ sendDuring: "tool" });

    expect(observed.followUpError).toBeUndefined();
    expect(deliveredInTurn(observed)).toBe(true);
    // Read once: it is not repeated into the later step.
    expect(requests.filter((request) => addedText(request).includes(STEER))).toHaveLength(1);
  }, LIVE);

  test("control: with delivery disabled the same assertion fails", async () => {
    const observed = await runScenario({ sendDuring: "tool", deliveryDisabled: true });

    // The backend accepted the message; the CLI never got it.
    expect(observed.followUpError).toBeUndefined();
    expect(carriesResult(requests[1], ASK_ID)).toBe(true);
    expect(deliveredInTurn(observed)).toBe(false);
    expect(requests.some((request) => addedText(request).includes(STEER))).toBe(false);
  }, LIVE);

  test("the running step completes, and permissions, ask-user and cost keep working", async () => {
    const observed = await runScenario({ sendDuring: "tool" });
    const frames = observed.frames.map(({ frame }) => frame);

    // The card was answered, its tool result streamed without error, no abort.
    expect(observed.asked).toHaveLength(1);
    const askResult = frames.find((frame) => frame.type === "tool_result" && frame.toolUseId === ASK_ID);
    expect(askResult).toMatchObject({ isError: false });
    expect(frames.some((frame) => frame.type === "status" && frame.status === "cancelled")).toBe(false);
    // The step after the follow-up still went through the permission bridge.
    expect(observed.permissions.map((request) => request.toolName)).toEqual(["Bash"]);
    expect(observed.permissions[0]?.input.command).toBe(BASH_COMMAND);
    expect(carriesResult(requests[2], BASH_ID)).toBe(false);
    // One terminal frame, last, a success that reports what it cost.
    const results = resultFrames(observed);
    expect(results).toHaveLength(1);
    expect(frames.at(-1)).toBe(results[0]!.frame);
    expect(results[0]!.frame).toMatchObject({ type: "result", outcome: "success", numTurns: 3 });
    expect(typeof (results[0]!.frame as { costUsd?: unknown }).costUsd).toBe("number");
    // A reload replays the follow-up as the user message it was, between the steps.
    expect(observed.history.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "Plan the voyage home.",
      STEER,
    ]);
  }, LIVE);
});

describe("a follow-up sent while the final answer is generated (#1003)", () => {
  test("runs before the turn ends, and the turn still ends on exactly one result", async () => {
    const observed = await runScenario({ sendDuring: "final" });
    const frames = observed.frames.map(({ frame }) => frame);

    expect(observed.followUpError).toBeUndefined();
    // The CLI ran it as a continuation: a fourth main request, carrying it.
    expect(requests).toHaveLength(4);
    expect(addedText(requests[3])).toContain(STEER);
    // The continuation's answer streamed, then one terminal frame closed the turn.
    const results = resultFrames(observed);
    expect(results).toHaveLength(1);
    expect(requests[3]!.at).toBeLessThan(results[0]!.at);
    expect(frames.at(-1)).toBe(results[0]!.frame);
    const text = frames.flatMap((frame) => (frame.type === "text_delta" ? [frame.text] : [])).join("");
    expect(text).toContain("Final answer 3.");
    // Both CLI runs counted: three steps, then one.
    expect(results[0]!.frame).toMatchObject({ outcome: "success", numTurns: 4 });
  }, LIVE);
});

describe("a follow-up with no turn to join", () => {
  test("is refused with BackendRequestError", async () => {
    const backend = createClaudeBackend({ brainPath: arrange(), log: () => {} });
    expect(backend.capabilities.followUp).toBe(true);
    await expect(backend.followUp!({ sessionId: "no-such-session", prompt: STEER })).rejects.toMatchObject({
      name: "BackendRequestError",
    });
  });
});

mockWorkerHostForSdkStream();
