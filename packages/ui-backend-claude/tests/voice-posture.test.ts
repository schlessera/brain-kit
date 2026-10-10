import { mockWorkerHostForSdkStream } from "./helpers/worker-host.js";
/**
 * The voice posture as a named allowlist (#111).
 *
 * `docs/decisions/voice-permission.md` ("The voice posture") fixes the tool set a
 * spoken turn runs under, with a reason per entry. These tests pin that
 * membership exactly, so a tool added to `DEFAULT_ALLOWED_TOOLS` cannot
 * silently widen it. They also drive one turn under the posture end to end.
 * That turn declares `enforceAllowedTools` and `noGrantSurface`: #173 refuses
 * the second without the first, and the voice posture is the case that rule
 * exists for.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTaxonomy } from "@schlessera/brain/internal";
import { openDatabase } from "../../module-jobs/src/db";
import jobsReview from "../../module-jobs/src/mcp/review";
import { configSchema as jobsConfigSchema } from "../../module-jobs/src/module";
import type { Options, query } from "@anthropic-ai/claude-agent-sdk";
import type {
  BackendActivityEvent,
  PermissionDecision,
  PermissionRequest,
  ServerMessage,
} from "@schlessera/brain-ui-sdk/server";

import { createClaudeBackend } from "../src/backend";
import { MASK_TOOL_NAME } from "../src/mask-tool";
import * as policy from "../src/tool-policy";

/**
 * Read off the module namespace so that the tree before #111 fails an
 * assertion, not the import.
 */
const VOICE = (policy as { VOICE_ALLOWED_TOOLS?: readonly string[] }).VOICE_ALLOWED_TOOLS;

/**
 * The decision record's two tables, read from the record itself so that a
 * change to either side fails here until the other agrees. Each row's first
 * cell names its tools in backticks. The one row that names none, "the bridge
 * tools, minus the mask editor", is read from its reason cell, which names
 * the bridge tools that are in and the one that is out.
 */
function recordTables(): { allowed: string[]; excluded: string[] } {
  const record = readFileSync(
    join(import.meta.dir, "../../../docs/decisions/voice-permission.md"),
    "utf-8"
  );
  const section = record.slice(record.indexOf("## The voice posture"));
  const tableAfter = (heading: string): string[][] => {
    const rows: string[][] = [];
    const lines = section.slice(section.indexOf(heading)).split("\n");
    let inTable = false;
    for (const line of lines) {
      if (line.startsWith("|")) {
        inTable = true;
        const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
        if (cells[0] === "Tool" || cells[0]?.startsWith("---")) continue;
        rows.push(cells);
      } else if (inTable) break;
    }
    return rows;
  };
  const names = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  const BRIDGE = "mcp__brain-ui__";
  const allowed: string[] = [];
  const excluded: string[] = [];
  for (const [first, why] of tableAfter("**Allowed:**")) {
    if (first!.startsWith("the bridge tools")) {
      // "`ask_user`, `get_current_location`, ... are auto-allowed today ...
      // `request_image_mask` needs the user to paint a region ... it is out."
      for (const name of names(why!)) {
        if (!/^[a-z_]+$/.test(name)) continue;
        (name === "request_image_mask" ? excluded : allowed).push(BRIDGE + name);
      }
      continue;
    }
    allowed.push(...names(first!));
  }
  for (const [first] of tableAfter("**Excluded, each for its own reason:**")) {
    excluded.push(...names(first!));
  }
  return { allowed, excluded };
}

const { allowed: RECORD_ALLOWED, excluded: RECORD_EXCLUDED } = recordTables();

describe("VOICE_ALLOWED_TOOLS", () => {
  test("the record's tables are read as the record states them", () => {
    // Guards the parser above: if it read nothing, every test below would
    // compare empty lists.
    expect(RECORD_ALLOWED).toContain("mcp__brain__brain_search");
    expect(RECORD_ALLOWED).toContain("mcp__brain-ui__show_block");
    expect(RECORD_EXCLUDED).toContain("Bash");
    expect(RECORD_EXCLUDED).toContain("mcp__brain-ui__request_image_mask");
    expect(RECORD_ALLOWED).toContain("mcp__brain__jobs_review");
    expect(RECORD_ALLOWED).toHaveLength(17);
    expect(RECORD_EXCLUDED).toHaveLength(15);
  });

  test("is exactly the decision record's allowed table", () => {
    expect([...(VOICE ?? [])].sort()).toEqual([...RECORD_ALLOWED].sort());
    // No duplicates hiding behind the sort.
    expect(new Set(VOICE ?? []).size).toBe(VOICE?.length ?? -1);
  });

  test("does not contain Bash", () => {
    // 192 of 192 measured approvals came from it, and its payload cannot be
    // read aloud. The whole cost of the voice posture, taken on purpose.
    expect(VOICE).toBeDefined();
    expect(VOICE).not.toContain("Bash");
  });

  test("contains nothing from the excluded table", () => {
    expect(VOICE).toBeDefined();
    for (const tool of RECORD_EXCLUDED) expect(VOICE, tool).not.toContain(tool);
  });

  test("is not derived from the default list: it holds nothing the record did not name", () => {
    // Every default tool is either in the voice set or excluded by name. A
    // tool added to the default list later fails here until someone decides
    // which table it belongs in.
    expect(VOICE).toBeDefined();
    expect(policy.DEFAULT_ALLOWED_TOOLS.length).toBeGreaterThan(0);
    for (const tool of policy.DEFAULT_ALLOWED_TOOLS) {
      expect(
        RECORD_ALLOWED.includes(tool) || RECORD_EXCLUDED.includes(tool),
        `${tool} is in DEFAULT_ALLOWED_TOOLS but in neither of the record's tables`
      ).toBe(true);
    }
  });
});

interface ToolCallOutcome {
  executed: boolean;
  message: string | undefined;
}

/**
 * One tool call through the runtime's precedence as measured for #124, #145
 * and #154, and re-measured against the runtime `MEASURED_RUNTIME` names by
 * scripts/measure-claude-runtime.ts. Every matching PreToolUse hook runs in parallel on the ORIGINAL
 * input, and their decisions combine: any `deny` blocks; otherwise any `ask`
 * forces the callback; otherwise an `allow` executes without it. After the
 * hooks come `disallowedTools`, `allowedTools` and the runtime's own
 * auto-approval, then `canUseTool`. `runtimeAutoApproves` stands in for the
 * runtime's own opinions before the callback, which the enforcement hook's
 * `ask` has to beat. `projectSettingsAllow` adds the measured project-settings
 * hook that answers `allow`.
 */
async function runToolCall(
  options: Options,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string,
  runtime: { autoApproves?: boolean; projectSettingsAllow?: boolean } = {}
): Promise<ToolCallOutcome> {
  const hooks = (options.hooks?.PreToolUse ?? [])
    .filter((group) => !group.matcher || new RegExp(group.matcher).test(toolName))
    .flatMap((group) => group.hooks);
  const outputs = (await Promise.all(
    hooks.map((hook) =>
      hook(
        { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: input, tool_use_id: toolUseId } as never,
        toolUseId,
        { signal: new AbortController().signal }
      )
    )
  )) as Array<{ hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }>;
  const decisions = outputs.map((output) => output?.hookSpecificOutput);
  if (runtime.projectSettingsAllow) decisions.push({ permissionDecision: "allow" });
  const denied = decisions.find((out) => out?.permissionDecision === "deny");
  if (denied) return { executed: false, message: denied.permissionDecisionReason };
  const asked = decisions.some((out) => out?.permissionDecision === "ask");
  if (!asked && decisions.some((out) => out?.permissionDecision === "allow")) {
    return { executed: true, message: undefined };
  }
  if ((options.disallowedTools ?? []).includes(toolName)) {
    return { executed: false, message: `${toolName} is disallowed.` };
  }
  if (!asked && ((options.allowedTools ?? []).includes(toolName) || runtime.autoApproves)) {
    return { executed: true, message: undefined };
  }
  const decision = (await options.canUseTool!(toolName, input, {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
  } as never)) as PermissionDecision;
  return decision.behavior === "allow"
    ? { executed: true, message: undefined }
    : { executed: false, message: decision.message };
}

/**
 * Run a voice turn (the named allowlist, enforced, with no grant surface) or
 * ordinary chat turn and hand its SDK options to each call WHILE the turn is
 * live, the way the runtime calls the hooks mid-turn. The bridge mirrors the
 * real host: a permission request is a `tool_approval_request` frame on the
 * wire, which here nobody could answer.
 */
async function duringTurn(
  calls: Array<(options: Options) => Promise<ToolCallOutcome & { id: string }>>,
  context: { mode?: "voice" | "chat"; brainPath?: string } = {}
): Promise<{
  value: ToolCallOutcome[];
  options: Options;
  requests: PermissionRequest[];
  frames: ServerMessage[];
  activity: BackendActivityEvent[];
}> {
  const requests: PermissionRequest[] = [];
  const frames: ServerMessage[] = [];
  const activity: BackendActivityEvent[] = [];
  const voice = context.mode !== "chat";
  let captured: Options | undefined;
  const value: ToolCallOutcome[] = [];
  const queryFn = ((params: { options?: Options }) => {
    captured = params.options!;
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "voice" };
      // One call at a time, each followed by its tool result, as the runtime
      // streams them: the result is what frees the write lock a mutating
      // call takes, so the next call is not left waiting on it.
      for (const call of calls) {
        const outcome = await call(captured!);
        value.push(outcome);
        yield {
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: outcome.id, content: "ok" }] },
        };
      }
      yield { type: "result", subtype: "success", session_id: "voice", total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
    })();
  }) as unknown as typeof query;
  const backend = createClaudeBackend({
    brainPath: context.brainPath ?? "/brain",
    queryFn,
    ...(voice && VOICE ? { allowedTools: [...VOICE] } : {}),
    log: () => {},
  });
  await backend.startTurn({
    prompt: "add this to my note about the garden",
    signal: new AbortController().signal,
    ...(voice ? { enforceAllowedTools: true, noGrantSurface: true } : {}),
    bridge: {
      emit: (msg) => frames.push(msg),
      requestPermission: async (request) => {
        requests.push(request);
        frames.push({
          type: "tool_approval_request",
          toolUseId: request.toolUseId,
          toolName: request.toolName,
          input: request.input,
          description: request.description,
        });
        return { behavior: "allow" };
      },
      // The per-turn runtime report (#211) is not what these tests are about.
    activity: (event) => {
      if (event.kind !== "runtime_observed") activity.push(event);
    },
      requestMask: async () => new Uint8Array(),
    },
  });
  return { value, options: captured!, requests, frames, activity };
}

const approvalFrames = (frames: ServerMessage[]) =>
  frames.filter((frame) => frame.type === "tool_approval_request");

/** One call, tagged with its id so its tool result can follow it. */
const call =
  (
    toolName: string,
    input: Record<string, unknown>,
    id: string,
    runtime?: { autoApproves?: boolean; projectSettingsAllow?: boolean }
  ) =>
  async (options: Options) => ({ id, ...(await runToolCall(options, toolName, input, id, runtime)) });

describe("a turn under the voice posture", () => {
  test("denies Bash without raising a card, even where the runtime or project settings would admit it", async () => {
    const turn = await duringTurn([
      call("Bash", { command: "git status" }, "bash-auto", { autoApproves: true }),
      call("Bash", { command: "ls" }, "bash-settings", { projectSettingsAllow: true }),
      call("Bash", { command: "rm -rf notes/old" }, "bash-destructive"),
    ]);

    expect(turn.value).toHaveLength(3);
    for (const outcome of turn.value) {
      expect(outcome.executed).toBe(false);
      expect(outcome.message).toContain("Bash");
    }
    expect(turn.requests).toHaveLength(0);
    expect(approvalFrames(turn.frames)).toHaveLength(0);
    expect(turn.activity.map((event) => event.kind)).toEqual([
      "permission_denied",
      "permission_denied",
      "permission_denied",
    ]);
  });

  test("allows brain_add and brain_update in that same turn: read-mostly, not read-only", async () => {
    const turn = await duringTurn([
      call("mcp__brain-ui__brain_add", { type: "note", title: "Garden" }, "add-1"),
      call(
        "mcp__brain-ui__brain_update",
        { path: "notes/garden.md", append_content: "Planted tomatoes." },
        "update-1"
      ),
      call("Bash", { command: "ls" }, "bash-1", { autoApproves: true }),
    ]);
    const [add, update, bash] = turn.value;

    expect(add!.executed).toBe(true);
    expect(update!.executed).toBe(true);
    expect(bash!.executed).toBe(false);
    expect(turn.requests).toHaveLength(0);
    expect(approvalFrames(turn.frames)).toHaveLength(0);
  });

  test("an archiving brain_update is still denied, not granted by the posture", async () => {
    const turn = await duringTurn([
      call("mcp__brain-ui__brain_update", { path: "notes/garden.md", status: "archived" }, "archive-1"),
    ]);
    expect(turn.value[0]!.executed).toBe(false);
    expect(approvalFrames(turn.frames)).toHaveLength(0);
  });

  test("the mask editor is not in the turn's allowlist, although the host offers it", async () => {
    const turn = await duringTurn([]);
    expect(turn.options.allowedTools).not.toContain(MASK_TOOL_NAME);
  });
});

for (const mode of ["voice", "chat"] as const) {
  test(`jobs_review executes the real queue query without a card in ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "brain-jobs-posture-"));
    const db = openDatabase(join(root, "jobs.db"));
    try {
      const insert = db.query(`INSERT INTO jobs (
        source, source_id, fingerprint, title, title_normalized,
        company, company_normalized, first_seen_at, last_seen_at, scraped_at,
        review_status, relevance_score, tags
      ) VALUES ('remoteok', ?, ?, ?, ?, 'Ithaca Fleet', 'ithaca fleet',
        '2026-09-30', '2026-09-30', '2026-09-30', 'queued', ?, '["navigation"]')`);
      insert.run("ithaca-1", "ithaca-1", "Navigation engineer", "navigation engineer", 90);
      insert.run("ithaca-2", "ithaca-2", "Shipwright", "shipwright", 45);
      expect(db.query("SELECT id FROM jobs").all()).toHaveLength(2);
      let result: Awaited<ReturnType<typeof jobsReview.run>> | undefined;
      let decideExecutions = 0;
      const reviewCall = async (options: Options) => {
        const input = { min_score: 70 };
        const outcome = await runToolCall(options, "mcp__brain__jobs_review", input, "jobs-review");
        if (outcome.executed) {
          result = await jobsReview.run(jobsReview.inputSchema.parse(input), {
            root, config: jobsConfigSchema.parse({ criteria: "career/criteria.md" }),
            taxonomy: buildTaxonomy({}), signal: new AbortController().signal,
          });
        }
        return { id: "jobs-review", ...outcome };
      };
      const decideCall = async (options: Options) => {
        // A project settings hook attempts to re-admit the unlisted mutator.
        const outcome = await runToolCall(options, "mcp__brain__jobs_decide", {}, "jobs-decide", {
          projectSettingsAllow: true,
        });
        if (outcome.executed) {
          decideExecutions++;
          db.exec("UPDATE jobs SET review_status = 'dismissed'");
        }
        return { id: "jobs-decide", ...outcome };
      };
      const turn = await duringTurn(mode === "voice" ? [reviewCall, decideCall] : [reviewCall], {
        mode, brainPath: root,
      });
      expect(turn.value[0]!.executed).toBe(true);
      expect(result?.jobs).toHaveLength(1);
      expect(result!.jobs[0]).toMatchObject({ title: "Navigation engineer", relevance_score: 90 });
      expect(turn.requests).toHaveLength(0);
      expect(approvalFrames(turn.frames)).toHaveLength(0);
      if (mode === "voice") {
        expect(turn.value[1]!.executed).toBe(false);
        expect(turn.value[1]!.message).toContain("jobs_decide");
        expect(decideExecutions).toBe(0);
        expect(db.query("SELECT review_status FROM jobs ORDER BY id").all()).toEqual([
          { review_status: "queued" }, { review_status: "queued" },
        ]);
        expect(turn.activity.map((event) => event.kind)).toEqual(["permission_denied"]);
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("jobs_review takes no mutation lock", () => {
  expect(policy.lockKeyForTool("mcp__brain__jobs_review", { min_score: 70 }, "/brain")).toBeNull();
  expect(policy.MUTATING_TOOLS.has("mcp__brain__jobs_review")).toBe(false);
});

mockWorkerHostForSdkStream();
