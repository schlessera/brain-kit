import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launchAgentWorker, prepareWorkerSandbox, WORKER_SCRATCH, type TurnTempAccess } from "@schlessera/brain-ui-sdk/internal";
import { createTurnTempTool, createTurnTempPressureHook } from "../packages/ui-backend-claude/src/turn-temp-tool";
import { createPiBridgeTools } from "../packages/ui-backend-pi/src/bridge-tools";

test("both turn_temp registrations report real private usage, keep linked bytes and emit purge receipts; Claude warns once", async () => {
  const parent = join(import.meta.dir, "../tmp");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "turn-temp-backends-"));
  const brain = join(root, "brain");
  mkdirSync(brain);
  const allowance = 8 * 1024 * 1024;
  const worker = launchAgentWorker({ brainPath: brain, env: {}, sandbox: prepareWorkerSandbox(brain, {}), turnTempBytes: allowance,
    command: [process.execPath, "-e", `import {writeFileSync} from 'node:fs';
      writeFileSync('/tmp/large.bin',new Uint8Array(${Math.ceil(allowance * .81)}));
      writeFileSync('/tmp/report.md','Odysseus returns.');
      await Bun.stdin.text();`] });
  const access: TurnTempAccess = { root: () => worker.turnTemp!.root, allowanceBytes: allowance,
    scratch: WORKER_SCRATCH, exclude: [], keep: [WORKER_SCRATCH], linkedText: () => "[Report](/tmp/report.md)" };
  const events: any[] = [];
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(`${access.root()}/report.md`) && Date.now() < deadline) await Bun.sleep(10);
    expect(readFileSync(`${access.root()}/report.md`, "utf8")).toBe("Odysseus returns.");
    const hook = createTurnTempPressureHook(access);
    const input = { hook_event_name: "PostToolUse", tool_name: "Bash" } as never;
    const context = { signal: new AbortController().signal };
    expect(await hook(input, undefined, context)).toMatchObject({ hookSpecificOutput: { additionalContext: expect.stringContaining("mcp__brain-ui__turn_temp") } });
    expect(await hook(input, undefined, context)).toEqual({ continue: true });
    const claude = createTurnTempTool(access, event => events.push(event));
    const pi = createPiBridgeTools({ brainPath: brain, capabilities: { turnTemp: true },
      turn: { turnTemp: access, bridge: { activity: (event: unknown) => events.push(event) } } as never }).find(tool => tool.name === "turn_temp")!;
    const invoke = async (backend: "claude" | "pi", input: object) => {
      const result = backend === "claude" ? await claude.handler(input as never, {}) : await pi.execute("purge-call", input as never);
      return JSON.parse(result.content.find((c: any) => c.type === "text")!.text);
    };
    for (const backend of ["claude", "pi"] as const) {
      const usage = await invoke(backend, { action: "usage" });
      expect(usage.limitBytes).toBe(allowance);
      expect(usage.usedBytes).toBeGreaterThan(allowance * .8);
      expect(usage.usedBytes).toBeLessThanOrEqual(allowance);
      expect(usage.largest[0].path).toBe("/tmp/large.bin");
      const result = await invoke(backend, { action: "purge", paths: ["report.md", "../outside"] });
      expect(result.skipped).toEqual([{ path: "/tmp/report.md", reason: "linked" }, { path: "../outside", reason: "outside" }]);
      expect(readFileSync(`${access.root()}/report.md`, "utf8")).toBe("Odysseus returns.");
    }
    expect(events).toHaveLength(2);
    for (const event of events) expect(event).toMatchObject({ kind: "turn_temp_purge", truncated: false,
      removedEntries: 0, skippedLinked: ["/tmp/report.md"], skippedOther: 1, limitBytes: allowance });
    const forced = await invoke("pi", { action: "purge", paths: ["report.md"], force: true });
    expect(forced.removedCount).toBe(1);
    expect(existsSync(`${access.root()}/report.md`)).toBe(false);
  } finally {
    worker.stdin.end();
    await worker.exited;
    worker.turnTemp!.close();
    rmSync(root, { recursive: true, force: true });
  }
});
