/**
 * Roadblock classification (#1671): every failed step in a turn becomes an
 * episode with the path that finally worked, its waste and a remedy class,
 * stored as a quiet `roadblock` governance event. Fixtures are frames as each
 * backend actually relays them, in the Odysseus world.
 */
import { describe, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";

import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/server";
import { StreamAdapter } from "../../ui-backend-claude/src/stream-adapter.js";
import { createBrainAccess } from "../../ui-backend-pi/src/brain-access.js";
import { mapPiEvent } from "../../ui-backend-pi/src/event-adapter.js";
import { createBrainTools, toolLockFromKeyed } from "../../ui-backend-pi/src/tools.js";
import { createTurnContext } from "../../ui-backend-pi/src/turn-context.js";
import { createTurnRecorder } from "../src/activity/recorder.js";
import { createActivityStore } from "../src/activity/store.js";
import { createUiDb } from "../src/db/client.js";
import {
  GOVERNANCE_EVENT_SCHEMAS,
  queryGovernanceEvents,
  recordGovernanceEvent,
  type GovernanceEvent,
} from "../src/governance/events.js";
import {
  classifyRoadblocks,
  commandIntent,
  recordTurnRoadblocks,
  shellTargets,
  type TracedCall,
  type TurnTrace,
} from "../src/governance/roadblocks.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T0 = 1_800_000_000_000;

function call(id: string, tool: string, input: unknown, at: number, result: { output: string; isError?: boolean } | { denied: string }): TracedCall {
  if ("denied" in result) {
    return { toolCallId: id, tool, input, startedAt: T0 + at, endedAt: T0 + at + 10, output: null, isError: false, denied: { reason: result.denied } };
  }
  return { toolCallId: id, tool, input, startedAt: T0 + at, endedAt: T0 + at + 50, output: result.output, isError: result.isError ?? false, denied: null };
}

function trace(calls: TracedCall[], over: Partial<TurnTrace> = {}): TurnTrace {
  return { startedAt: T0, endedAt: T0 + 10_000, calls, usage: [], finalUsage: null, outcomeDetail: null, ...over };
}

const EROFS = "EROFS: read-only file system, open '/srv/ithaca/brain/.brain/suitors.md'";

describe("roadblock episodes", () => {
  test("EROFS on .brain/x, then a write to .brain/scratch/x: one fs_denied episode resolved by it, remedy guidance", () => {
    const episodes = classifyRoadblocks(trace([
      call("w1", "Write", { file_path: ".brain/suitors.md", content: "108 suitors" }, 1000, { output: EROFS, isError: true }),
      // A success in another family in between must not close the write episode.
      call("r1", "Read", { file_path: "context/penelope.md" }, 1200, { output: "The loom." }),
      call("w2", "Write", { file_path: ".brain/scratch/suitors.md", content: "108 suitors" }, 1500, { output: "File written." }),
    ], {
      usage: [
        { at: T0 + 1100, tokens: 300, costUsd: 0.03 },
        { at: T0 + 1400, tokens: 700, costUsd: 0.07 },
        { at: T0 + 1700, tokens: 900, costUsd: 0.09 },
      ],
    }), []);

    expect(episodes).toEqual([{
      category: "fs_denied",
      family: "file_write",
      signature: "file_write|.brain/*|fs_denied EROFS .brain/*",
      failures: [{ toolCallId: "w1", signature: "Write|.brain/*|fs_denied EROFS .brain/*", category: "fs_denied" }],
      resolution: { toolCallId: "w2", signature: "Write|scratch/*" },
      remedy: "guidance",
      // From the failed attempt (nothing spent yet) to the start of the one that worked.
      waste: { tokens: 700, costUsd: 0.07, ms: 500 },
      eventIds: [],
    }]);
  });

  test("an unresolved repeated failure is a retry episode with remedy capability", () => {
    const push = (id: string, at: number) => call(id, "Bash", { command: "git push origin main" }, at,
      { output: "fatal: could not read Username for the harbor\nExit code 128", isError: true });
    const [episode, ...rest] = classifyRoadblocks(trace([push("b1", 100), push("b2", 300), push("b3", 600)]), []);

    expect(rest).toEqual([]);
    expect(episode).toMatchObject({
      category: "retry",
      family: "shell:git push",
      signature: "shell:git push|git push|shell_nonzero exit 128",
      resolution: null,
      remedy: "capability",
      // Until turn end; no live usage was reported, so tokens and cost are unknown, not zero.
      waste: { tokens: null, costUsd: null, ms: 9900 },
    });
    expect(episode!.failures.map((f) => f.category)).toEqual(["shell_nonzero", "retry", "retry"]);
  });

  test("a resolution only through turn temp is a capability gap, not guidance", () => {
    const [episode] = classifyRoadblocks(trace([
      call("w1", "write_file", { path: "context/odyssey.md", content: "x" }, 0, { output: "Error: EACCES: permission denied, open 'context/odyssey.md'", isError: true }),
      call("w2", "write_file", { path: "/tmp/odyssey.md", content: "x" }, 100, { output: "Wrote /tmp/odyssey.md." }),
    ]), []);
    expect(episode).toMatchObject({ category: "fs_denied", resolution: { toolCallId: "w2" }, remedy: "capability" });
  });

  test("pi's bash exit line is a nonzero exit; grep's exit 1 is an answer, as Claude Code treats it", () => {
    const episodes = classifyRoadblocks(trace([
      call("p1", "bash", { command: "grep -r Calypso notes" }, 0, { output: "$ grep -r Calypso notes\n\n[exit 1]" }),
      call("p2", "bash", { command: "cd notes && brain index --force" }, 100, { output: "$ brain index\nindex failed\n[exit 2]" }),
    ]), []);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ category: "shell_nonzero", family: "shell:brain index",
      failures: [{ toolCallId: "p2", category: "shell_nonzero" }] });
  });

  test("network refusals and tool errors get their own categories", () => {
    const episodes = classifyRoadblocks(trace([
      call("c1", "Bash", { command: "curl https://sirens.example/song" }, 0, { output: "curl: (6) Could not resolve host: sirens.example\nExit code 6", isError: true }),
      call("m1", "mcp__brain-ui__brain_update", { path: "notes/ithaca.md" }, 100, { output: "Document not found", isError: true }),
    ]), []);
    expect(episodes.map((e) => [e.family, e.category])).toEqual([["shell:curl", "network_refused"], ["brain_write", "tool_error"]]);
  });

  test("a denied call is permission_denied, and the policy event that refused it upgrades it to policy_block", () => {
    const events: GovernanceEvent[] = [
      { id: 7, sessionId: null, turnId: "t", at: T0 + 5, kind: "policy_block", schemaVersion: 1, actor: "interactive", model: null, profile: "governed",
        payload: { tool: "Bash", input: "git push --force origin main", inputTruncated: false, rule: { list: "commands.deny", index: 0, pattern: "^git push --force" }, policyHash: null } },
      { id: 9, sessionId: null, turnId: "t", at: T0 + 9000, kind: "budget_block", schemaVersion: 1, actor: "interactive", model: null, profile: "governed",
        payload: { scope: "turn", unit: "usd", limit: 2, observed: 2.1, source: "default", stage: "mid_turn" } },
    ];
    const episodes = classifyRoadblocks(trace([
      call("d1", "Bash", { command: "git push --force origin main" }, 0, { denied: "Blocked by policy." }),
      call("d2", "Bash", { command: "git push origin main" }, 100, { output: "Everything up-to-date" }),
      call("u1", "Edit", { file_path: "notes/ithaca.md" }, 200, { denied: "user declined" }),
    ]), events);
    expect(episodes).toEqual([
      expect.objectContaining({ category: "policy_block", family: "shell:git push", eventIds: [7], remedy: "guidance", resolution: expect.objectContaining({ toolCallId: "d2" }) }),
      expect.objectContaining({ category: "permission_denied", family: "file_write", resolution: null, remedy: "capability" }),
      expect.objectContaining({ category: "budget", family: "budget", eventIds: [9], failures: [expect.objectContaining({ toolCallId: null })] }),
    ]);
  });

  test("the signature keeps the program and area, never absolute roots, file names or arguments", () => {
    expect(commandIntent("cd /srv/ithaca && GIT_TRACE=1 git -C /srv/ithaca push --force origin main")).toBe("git push");
    expect(commandIntent("sudo timeout 30 python3 /srv/ithaca/scripts/count-suitors.py --secret hunter2")).toBe("python3");
    const [episode] = classifyRoadblocks(trace([
      call("w1", "Bash", { command: "echo token=aeolus-bag-of-winds > /srv/ithaca/brain/.brain/winds.txt" }, 0,
        { output: "bash: /srv/ithaca/brain/.brain/winds.txt: Read-only file system\nExit code 1", isError: true }),
    ]), []);
    expect(episode!.signature).toBe("shell:echo|echo|fs_denied EROFS .brain/*");
    expect(JSON.stringify(episode)).not.toMatch(/srv|aeolus|winds/);
  });

  test("identical frames always produce identical episodes (property)", () => {
    let seed = 1671;
    const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
    const tools = ["Bash", "bash", "Write", "write_file", "Read", "Edit", "WebFetch", "mcp__brain-ui__brain_update"] as const;
    const inputs = [{ command: "git push origin main" }, { command: "brain index" }, { file_path: ".brain/x.md" },
      { file_path: ".brain/scratch/x.md" }, { path: "/tmp/x" }, { url: "https://sirens.example/song" }];
    const outputs = [{ output: "ok" }, { output: EROFS, isError: true }, { output: "fatal\nExit code 1", isError: true },
      { output: "$ x\n[exit 3]" }, { output: "ECONNREFUSED", isError: true }, { output: "boom", isError: true }, { denied: "user declined" }];
    for (let round = 0; round < 300; round += 1) {
      const calls = Array.from({ length: Math.floor(rand() * 12) }, (_, i) =>
        call(`c${i}`, pick(tools), pick(inputs), Math.floor(rand() * 5000), pick(outputs) as { output: string }));
      const turn = trace(calls, rand() < 0.5 ? {} : { usage: [{ at: T0 + 2500, tokens: 1000, costUsd: null }], finalUsage: { tokens: 2000, costUsd: 0.2 } });
      const first = classifyRoadblocks(turn, []);
      expect(classifyRoadblocks(structuredClone(turn), [])).toEqual(first);
      expect(JSON.stringify(classifyRoadblocks(turn, []))).toBe(JSON.stringify(first));
      for (const payload of first) expect(GOVERNANCE_EVENT_SCHEMAS.roadblock.payload.safeParse(payload).success).toBe(true);
    }
  });
});

describe("review regressions", () => {
  test("Claude's grep exit 1 is an answer even when flagged as an error", () => {
    expect(classifyRoadblocks(trace([
      call("g1", "Bash", { command: "rg Calypso notes | grep -v draft" }, 0, { output: "Exit code 1", isError: true }),
    ]), [])).toEqual([]);
  });

  test("a note that merely mentions /tmp is not a turn-temp workaround", () => {
    const [episode] = classifyRoadblocks(trace([
      call("w1", "Write", { file_path: ".brain/log.md", content: "x" }, 0, { output: EROFS, isError: true }),
      call("w2", "Write", { file_path: ".brain/scratch/log.md", content: "Penelope kept the draft in /tmp/ and ~/ for a while" }, 100, { output: "ok" }),
    ]), []);
    expect(episode).toMatchObject({ resolution: { toolCallId: "w2" }, remedy: "guidance" });
  });

  test("a parallel success that started before the failure was known does not resolve it", () => {
    const parallel = (id: string, path: string, startAt: number, endAt: number, output: string, isError: boolean): TracedCall =>
      ({ toolCallId: id, tool: "Write", input: { file_path: path }, startedAt: T0 + startAt, endedAt: T0 + endAt, output, isError, denied: null });
    const [episode] = classifyRoadblocks(trace([
      parallel("a", ".brain/a.md", 0, 400, EROFS, true),
      parallel("b", ".brain/scratch/b.md", 10, 50, "ok", false),
    ]), []);
    expect(episode).toMatchObject({ resolution: null, remedy: "capability" });
  });

  test("an egress denial attaches only to the one connecting call in flight, never to an unrelated write", () => {
    const egress = (id: number): GovernanceEvent => ({ id, sessionId: null, turnId: "t", at: T0 + 20, kind: "egress_denial", schemaVersion: 1,
      actor: "interactive", model: null, profile: "governed",
      payload: { host: "sirens.example", port: 443, method: null, reason: "not_allowlisted", bytes: null } });
    const write = call("w1", "Write", { file_path: ".brain/a.md" }, 0, { output: EROFS, isError: true });
    const curl = call("c1", "Bash", { command: "curl https://sirens.example" }, 5, { output: "curl: (56) proxy refused\nExit code 56", isError: true });
    const withCurl = classifyRoadblocks(trace([write, curl]), [egress(3)]);
    expect(withCurl.find((e) => e.family === "file_write")).toMatchObject({ category: "fs_denied", eventIds: [] });
    expect(withCurl.find((e) => e.family === "shell:curl")).toMatchObject({ category: "network_refused", eventIds: [3] });
    const writeOnly = classifyRoadblocks(trace([write]), [egress(4)]);
    expect(writeOnly.map((e) => [e.family, e.eventIds])).toEqual([["network", [4]], ["file_write", []]]);
  });

  test("wrapper options, scripts, user-chosen directories and hosts stay out of signatures", () => {
    expect(commandIntent("sudo -u penelope git push")).toBe("git push");
    expect(commandIntent("./deploy-to-ithaca.sh --now")).toBe("<script>");
    expect(commandIntent("/usr/bin/git status")).toBe("git status");
    const [episode] = classifyRoadblocks(trace([
      call("w1", "Write", { file_path: "clients/telemachus/plan.md" }, 0, { output: "EACCES: permission denied, open 'clients/telemachus/plan.md'", isError: true }),
      call("f1", "WebFetch", { url: "https://private.ithaca.example/x" }, 100, { output: "ECONNREFUSED", isError: true }),
    ]), []);
    expect(episode!.signature).toBe("file_write|<dir>/*|fs_denied EACCES <dir>/*");
    expect(JSON.stringify(classifyRoadblocks(trace([call("f1", "WebFetch", { url: "https://private.ithaca.example/x" }, 0, { output: "ECONNREFUSED", isError: true })]), [])))
      .not.toMatch(/ithaca|telemachus/);
  });

  test("long call ids and hundreds of large failures still fit the payload schema", () => {
    const id = "x".repeat(256);
    const calls = Array.from({ length: 400 }, (_, i) => call(`${id}${i}`, "Bash", { command: `git push origin ${"b".repeat(900)}` }, i * 10,
      { output: "Exit code 1", isError: true }));
    const [episode] = classifyRoadblocks(trace(calls), []);
    expect(GOVERNANCE_EVENT_SCHEMAS.roadblock.payload.safeParse(episode).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(episode))).toBeLessThan(64 * 1024);
  });

  test("each wrapper's own options are skipped, and a value after an option is never a subcommand", () => {
    expect(commandIntent("sudo -n git push")).toBe("git push");
    expect(commandIntent("sudo -S --host ithaca git push")).toBe("git push");
    expect(commandIntent("env -i HOME=/x git push")).toBe("git push");
    expect(commandIntent("sudo --user=penelope git push")).toBe("git push");
    expect(commandIntent("timeout -s KILL 30 brain index")).toBe("brain index");
    expect(commandIntent("gh -R ithaca/palace pr create")).toBe("gh");
  });

  test("exit 1 is an answer only when the search or diff produced the status", () => {
    const shell = (command: string) => classifyRoadblocks(trace([call("s", "Bash", { command }, 0, { output: "Exit code 1", isError: true })]), []);
    expect(shell("false && grep x notes/ithaca.md")).toHaveLength(1);
    expect(shell("grep -q Calypso notes/ithaca.md; false")).toHaveLength(1);
    expect(shell("rg missing notes | head -1 | grep -c x")).toEqual([]);
  });

  test("an egress denial attaches only to the call that names its host", () => {
    const egress: GovernanceEvent = { id: 5, sessionId: null, turnId: "t", at: T0 + 20, kind: "egress_denial", schemaVersion: 1,
      actor: "interactive", model: null, profile: "governed",
      payload: { host: "sirens.example", port: 443, method: null, reason: "not_allowlisted", bytes: null } };
    const episodes = classifyRoadblocks(trace([call("p", "Bash", { command: "printf '%d' x" }, 0, { output: "invalid number\nExit code 1", isError: true })]), [egress]);
    expect(episodes.map((e) => [e.family, e.category, e.eventIds])).toEqual([["network", "network_refused", [5]], ["shell:printf", "shell_nonzero", []]]);
  });

  test("a shell workaround is judged by where it wrote, not by what it wrote", () => {
    const fixedBy = (command: string) => classifyRoadblocks(trace([
      call("a", "Bash", { command: "echo draft > .brain/a" }, 0, { output: "bash: .brain/a: Read-only file system\nExit code 1", isError: true }),
      call("b", "Bash", { command }, 100, { output: "" }),
    ]), [])[0]!.remedy;
    expect(fixedBy(`echo "kept in /tmp/ for now" > .brain/scratch/a`)).toBe("guidance");
    expect(fixedBy("echo draft > /tmp/a")).toBe("capability");
    expect(fixedBy(`echo ${"x".repeat(9000)} | tee $BRAIN_WORKER_SCRATCH/a`)).toBe("capability");
  });

  test("known flag-only globals keep the subcommand, so a later status does not resolve a failed push", () => {
    expect(commandIntent("git --no-pager push origin main")).toBe("git push");
    const episodes = classifyRoadblocks(trace([
      call("p", "Bash", { command: "git --no-pager push" }, 0, { output: "rejected\nExit code 1", isError: true }),
      call("s", "Bash", { command: "git --no-pager status" }, 100, { output: "clean" }),
    ]), []);
    expect(episodes[0]).toMatchObject({ family: "shell:git push", resolution: null });
  });

  test("write targets: descriptor redirections count, duplications and other -o options do not", () => {
    expect(shellTargets("make 1>/tmp/out 2>&1")).toEqual(["/tmp/out"]);
    expect(shellTargets("brain index &>> /tmp/log")).toEqual(["/tmp/log"]);
    expect(shellTargets("grep -o /tmp/pattern notes/ithaca.md")).toEqual([]);
    expect(shellTargets("curl -o /tmp/song https://sirens.example")).toEqual(["/tmp/song"]);
    expect(shellTargets("curl --output=/tmp/song https://sirens.example")).toEqual(["/tmp/song"]);
  });

  test("an egress denial never attaches to a file write whose content names the host", () => {
    const egress: GovernanceEvent = { id: 6, sessionId: null, turnId: "t", at: T0 + 20, kind: "egress_denial", schemaVersion: 1,
      actor: "interactive", model: null, profile: "governed",
      payload: { host: "sirens.example", port: 443, method: null, reason: "not_allowlisted", bytes: null } };
    const episodes = classifyRoadblocks(trace([
      call("w", "Write", { file_path: ".brain/a.md", content: "see https://sirens.example" }, 0, { output: EROFS, isError: true }),
    ]), [egress]);
    expect(episodes.find((e) => e.family === "file_write")).toMatchObject({ category: "fs_denied", eventIds: [] });
  });

  test("long call ids stay distinct", () => {
    const id = "x".repeat(256);
    const [episode] = classifyRoadblocks(trace([
      call(`${id}1`, "Write", { file_path: ".brain/a" }, 0, { output: EROFS, isError: true }),
      call(`${id}2`, "Write", { file_path: ".brain/a" }, 100, { output: EROFS, isError: true }),
    ]), []);
    const ids = episode!.failures.map((f) => f.toolCallId);
    expect(new Set(ids).size).toBe(2);
    for (const value of ids) expect(value!.length).toBeLessThanOrEqual(200);
  });

  test("wide characters still fit the writer's byte limit", () => {
    const calls = Array.from({ length: 200 }, (_, i) => call(`${"\u{1F30A}".repeat(100)}${i}`, `mcp__${"\u{1F30A}".repeat(50)}__x`,
      { path: ".brain/a" }, i, { output: "boom", isError: true }));
    const db = createUiDb(":memory:");
    const who = { turnId: "turn-wide", sessionId: null, actor: "interactive" as const, model: null, profile: null };
    expect(recordTurnRoadblocks(db, who, trace(calls))).toBe(1);
  });

  test("usage samples without token counters keep token waste unknown", () => {
    const [episode] = classifyRoadblocks(trace([
      call("w1", "Write", { file_path: ".brain/a.md" }, 0, { output: EROFS, isError: true }),
      call("w2", "Write", { file_path: ".brain/scratch/a.md" }, 500, { output: "ok" }),
    ], { usage: [{ at: T0 + 100, tokens: null, costUsd: 0.01 }, { at: T0 + 400, tokens: null, costUsd: 0.02 }] }), []);
    expect(episode!.waste).toEqual({ tokens: null, costUsd: 0.02, ms: 500 });
  });
});

describe("recording", () => {
  test("episodes are stored once per turn as roadblock events, with the turn's other events cited", () => {
    const db = createUiDb(":memory:");
    db.query("INSERT INTO sessions (id, title, created_at, last_active_at) VALUES ('sess-ithaca', 'Voyage', ?, ?)").run(T0, T0);
    const { id } = recordGovernanceEvent(db, { kind: "read_only_refusal", sessionId: "sess-ithaca", turnId: "turn-1", actor: "interactive",
      model: null, profile: "governed", at: T0 + 1010,
      payload: { path: ".brain/suitors.md", protection: "tier_a", code: "EROFS", tool: "Write", alternative: ".brain/scratch/" } });
    const turn = trace([
      call("w1", "Write", { file_path: ".brain/suitors.md" }, 1000, { output: EROFS, isError: true }),
      call("w2", "Write", { file_path: ".brain/scratch/suitors.md" }, 1500, { output: "File written." }),
    ]);
    const who = { turnId: "turn-1", sessionId: "sess-ithaca", actor: "interactive" as const, model: "claude-opus-5", profile: null };
    expect(recordTurnRoadblocks(db, who, turn)).toBe(1);
    expect(recordTurnRoadblocks(db, who, turn)).toBe(0);
    const stored = queryGovernanceEvents(db, { kinds: ["roadblock"], limit: 10 });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ sessionId: "sess-ithaca", turnId: "turn-1", actor: "interactive", model: "claude-opus-5",
      payload: { category: "fs_denied", eventIds: [id], resolution: { toolCallId: "w2" } } });
  });
});

/** A recorder wired the way the ws host wires it, plus where its roadblocks land. */
function recorded(turnId: string) {
  const db = createUiDb(":memory:");
  const store = createActivityStore(db, { writer: "test" });
  const recorder = createTurnRecorder({ store, governanceDb: db }, { turnId, sessionId: null });
  return { db, store, recorder, roadblocks: () => queryGovernanceEvents(db, { turnId, kinds: ["roadblock"], limit: 50 }) };
}

describe("both backends, through the turn recorder", () => {
  test("Claude: a native Write refused with EROFS, then a write to scratch", () => {
    const { recorder, roadblocks } = recorded("turn-claude");
    const adapter = new StreamAdapter();
    const frames: ServerMessage[] = [];
    const sdk = (msg: unknown) => frames.push(...adapter.adapt(msg as never));
    const toolUse = (id: string, name: string, input: unknown) => {
      sdk({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name } } });
      sdk({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
    };
    const toolResult = (id: string, content: string, isError: boolean) =>
      sdk({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
    toolUse("toolu_1", "Write", { file_path: "/srv/ithaca/brain/.brain/suitors.md", content: "108" });
    toolResult("toolu_1", `<tool_use_error>${EROFS}</tool_use_error>`, true);
    toolUse("toolu_2", "Bash", { command: "ls .brain" });
    toolResult("toolu_2", "scratch", false);
    toolUse("toolu_3", "Write", { file_path: "/srv/ithaca/brain/.brain/scratch/suitors.md", content: "108" });
    toolResult("toolu_3", "File created successfully", false);
    for (const frame of frames) recorder.observeFrame(frame);
    recorder.finish("success");

    const events = roadblocks();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: "interactive", profile: null, payload: {
      category: "fs_denied", family: "file_write", resolution: { toolCallId: "toolu_3" }, remedy: "guidance",
      failures: [{ toolCallId: "toolu_1", category: "fs_denied" }],
      // This legacy fixture sends no completed usage: unknown, never zero.
      waste: { tokens: null, costUsd: null },
    } });
    expect((events[0]!.payload as { waste: { ms: number } }).waste.ms).toBeGreaterThanOrEqual(0);
  });

  test("pi: the real bash tool failing the same way twice, with output past its clip", async () => {
    const root = mkdtempSync(join(tmpdir(), "roadblock-pi-"));
    try {
      const tools = Object.fromEntries(createBrainTools({ brain: createBrainAccess(root), turn: createTurnContext(),
        lock: toolLockFromKeyed(createKeyedLock()) }).map((t) => [t.name, t]));
      const { recorder, roadblocks } = recorded("turn-pi");
      // Longer than the tool's 30 000-byte clip: the exit line must survive it.
      const command = "head -c 40000 /dev/zero | tr '\\0' 'x'; exit 3";
      for (const id of ["pi-1", "pi-2"]) {
        const args = { command };
        for (const frame of mapPiEvent({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args } as never)) recorder.observeFrame(frame);
        const result = await tools.bash!.execute(id, args, undefined, undefined, {} as never);
        for (const frame of mapPiEvent({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result, isError: false } as never)) recorder.observeFrame(frame);
      }
      recorder.finish("success");

      const events = roadblocks();
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({ category: "retry", family: "shell:head", resolution: null, remedy: "capability",
        signature: "shell:head|head|shell_nonzero exit 3",
        failures: [{ toolCallId: "pi-1", category: "shell_nonzero" }, { toolCallId: "pi-2", category: "retry" }] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a turn without roadblocks records nothing, and a broken store never fails the turn", () => {
    const quiet = recorded("turn-quiet");
    quiet.recorder.observeFrame({ type: "tool_use_start", toolUseId: "ok", toolName: "Read" });
    quiet.recorder.observeFrame({ type: "tool_result", toolUseId: "ok", output: "Ithaca", isError: false });
    quiet.recorder.finish("success");
    expect(quiet.roadblocks()).toEqual([]);

    const db = createUiDb(":memory:");
    const store = createActivityStore(db, { writer: "test" });
    const recorder = createTurnRecorder({ store, governanceDb: new Database(":memory:") }, { turnId: "turn-broken", sessionId: null });
    recorder.observeFrame({ type: "tool_use_start", toolUseId: "w", toolName: "Write" });
    recorder.observeFrame({ type: "tool_result", toolUseId: "w", output: EROFS, isError: true });
    expect(() => recorder.finish("success")).not.toThrow();
    expect(store.getSpan("turn-broken:turn")?.outcome).toBe("success");
  });
});

test("ordinary completed inference measures roadblock waste without resumed terminal history",()=>{
 let now=T0;const clock=spyOn(Date,"now").mockImplementation(()=>now);
 const {db,recorder,roadblocks}=recorded("athena-budget-waste");
 try {
  now+=100;recorder.observeFrame({type:"tool_use_start",toolUseId:"loom",toolName:"Write"});
  recorder.observeFrame({type:"tool_use_complete",toolUseId:"loom",toolName:"Write",input:{file_path:".brain/notes.md"}});
  now+=100;recorder.observeFrame({type:"tool_result",toolUseId:"loom",output:EROFS,isError:true});
  now+=100;recorder.observeActivity({kind:"usage",atToolBoundary:true,usage:{inputTokens:10,costUsd:0.5}});
  now+=100;recorder.observeFrame({type:"result",sessionId:"ithaca",outcome:"success",isError:false,durationMs:400,numTurns:1,costUsd:500,usage:{inputTokens:10000,costUsd:500}});
  now+=100;recorder.finish("success");
  expect(roadblocks()[0]?.payload,"BUDGET_GENERAL_ROADBLOCK_WASTE_IS_PER_TURN").toMatchObject({waste:{tokens:10,costUsd:0.5}});
 }finally{clock.mockRestore();db.close()}
});


describe("abandoned accounting boundary", () => {
  const missing = (id = "probe", at = 100) => call(id, "Read", { file_path: "notes/missing.md" }, at, { output: "ENOENT", isError: true });
  const success = (at = 500) => call("search", "Grep", { pattern: "Ithaca" }, at, { output: "notes/odyssey.md" });
  const usage = { usage: [{ at: T0 + 50, tokens: 10, costUsd: 0.01 }, { at: T0 + 400, tokens: 30, costUsd: 0.03 }],
    finalUsage: { tokens: 1000, costUsd: 1 } };
  test("single missing-path probe is abandoned and bounded at eligible other-family success start", () => {
    const [episode] = classifyRoadblocks(trace([missing(), success()], usage), []);
    expect(episode).toMatchObject({ remedy: "abandoned", resolution: null, waste: { tokens: 20, ms: 400 } });
    expect(episode!.waste.costUsd).toBeCloseTo(0.02);
  });
  test("parallel success and success at failure-known time are not recovery evidence", () => {
    for (const at of [110, 150]) {
      const [episode] = classifyRoadblocks(trace([missing(), success(at)], usage), []);
      expect(episode).toMatchObject({ remedy: "capability", resolution: null, waste: { tokens: 990, ms: 9900 } });
    }
  });
  test("a later failure resets the boundary and repeated unresolved failures remain capability", () => {
    const [episode] = classifyRoadblocks(trace([missing(), success(200), missing("retry", 300), success(700)], usage), []);
    expect(episode).toMatchObject({ remedy: "capability", resolution: null, waste: { ms: 600, tokens: 20 } });
    const [withoutSuccess] = classifyRoadblocks(trace([missing(), missing("retry", 300)], usage), []);
    expect(withoutSuccess).toMatchObject({ remedy: "capability", waste: { ms: 9900, tokens: 990 } });
  });
  test("bounded unknown usage never borrows the final turn total", () => {
    const [episode] = classifyRoadblocks(trace([missing(), success()], { finalUsage: usage.finalUsage }), []);
    expect(episode).toMatchObject({ remedy: "abandoned", waste: { tokens: null, costUsd: null, ms: 400 } });
    const [partial] = classifyRoadblocks(trace([missing(), success()], { ...usage,
      usage: [{ at: T0 + 400, tokens: null, costUsd: 0.03 }] }), []);
    expect(partial).toMatchObject({ waste: { tokens: null, costUsd: 0.03 } });
  });
  test("later actual same-family resolution preserves guidance and its original bound", () => {
    const fixed = call("read-found", "Read", { file_path: "notes/odyssey.md" }, 900, { output: "Ithaca" });
    const [episode] = classifyRoadblocks(trace([missing(), success(), fixed], usage), []);
    expect(episode).toMatchObject({ remedy: "guidance", resolution: { toolCallId: "read-found" }, waste: { ms: 800 } });
  });
});


test("source-qualified recorder retains abandoned probe evidence after a successful answer", () => {
  let now = T0;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const { db, recorder, roadblocks } = recorded("turn-abandoned-recorder");
  try {
    now += 100;
    recorder.observeFrame({ type: "tool_use_start", toolUseId: "probe", toolName: "Read" });
    recorder.observeFrame({ type: "tool_use_complete", toolUseId: "probe", toolName: "Read", input: { file_path: "notes/missing.md" } });
    now += 50;
    recorder.observeFrame({ type: "tool_result", toolUseId: "probe", output: "ENOENT", isError: true });
    now += 50;
    recorder.observeActivity({ kind: "usage", atToolBoundary: true, usage: { inputTokens: 20, costUsd: 0.02 } });
    now += 100;
    recorder.observeFrame({ type: "tool_use_start", toolUseId: "search", toolName: "Grep" });
    recorder.observeFrame({ type: "tool_use_complete", toolUseId: "search", toolName: "Grep", input: { pattern: "Ithaca" } });
    now += 50;
    recorder.observeFrame({ type: "tool_result", toolUseId: "search", output: "notes/odyssey.md", isError: false });
    now += 100;
    recorder.observeActivity({ kind: "usage", atToolBoundary: true, usage: { inputTokens: 200, costUsd: 0.2 } });
    recorder.observeFrame({ type: "text_delta", text: "The voyage is recorded in the Odyssey." });
    recorder.observeFrame({ type: "result", sessionId: "ithaca", outcome: "success", isError: false, durationMs: 450,
      numTurns: 1, costUsd: 900, usage: { inputTokens: 9000, costUsd: 900 } });
    recorder.finish("success");
    expect(roadblocks()).toHaveLength(1);
    expect(roadblocks()[0]!.payload).toMatchObject({ remedy: "abandoned", resolution: null,
      waste: { tokens: 20, costUsd: 0.02, ms: 200 } });
  } finally { clock.mockRestore(); db.close(); }
});
