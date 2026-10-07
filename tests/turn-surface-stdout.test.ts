import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeSurfaceProcess } from "../scripts/turn-surface-stdout";
import { successfulSurfaceReceipt } from "../scripts/turn-surface-admission";
import { TurnObservation } from "../scripts/turn-surface-observation";

test("native split UTF-8 and final result survive delayed SDK reader and reader throw", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-stdout-"));
  const frame = { type: "result", subtype: "error_max_budget_π", total_cost_usd: 0.12 };
  const source = JSON.stringify(frame); // Deliberately no trailing newline.
  const child = spawn("node", ["-e", `const bytes=Buffer.from(${JSON.stringify(source)});let i=0;const t=setInterval(()=>{process.stdout.write(bytes.subarray(i,i+1));if(++i===bytes.length)clearInterval(t)},1)`],
    { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  const captured: unknown[] = [];
  const process = observeSurfaceProcess(child, join(root, "stdout.jsonl"), value => captured.push(value));
  const chunks: Buffer[] = [];
  child.stdout.on("data", chunk => chunks.push(Buffer.from(chunk)));
  let thrown = false;
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    const forwarded: Buffer[] = [];
    for await (const chunk of process.stdout) forwarded.push(Buffer.from(chunk));
    expect(Buffer.concat(forwarded).equals(Buffer.from(source))).toBe(true);
    // The observer has retained the final result before the SDK rejects it.
    if (captured.length) throw Error("controlled SDK parser rejection");
  } catch (error) {
    thrown = error instanceof Error && error.message === "controlled SDK parser rejection";
  } finally {
    expect(await exited).toBe(0);
    expect(thrown).toBe(true);
    expect(chunks.some(chunk => chunk.at(-1) === 0xcf)).toBe(true);
    expect(captured).toEqual([frame]);
    expect(readFileSync(join(root, "stdout.jsonl")).equals(Buffer.from(source))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
});
test("native late EOF receipt survives an early SDK consumer throw; missing raw usage remains unknown", async () => {
  const root = mkdtempSync(join(tmpdir(), "surface-late-stdout-"));
  const initial = { type: "assistant", parent_tool_use_id: null, message: { id: "msg_late", model: "claude-sonnet-5-5",
    content: [{ type: "text", text: "Fictional answer" }], usage: { input_tokens: 3, output_tokens: 2 } } };
  const final = { type: "result", subtype: "success" }; // Deliberate missing modelUsage.
  const bytes = JSON.stringify(initial) + "\n" + JSON.stringify(final);
  const child = spawn("node", ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(initial)+"\n")});setTimeout(()=>process.stdout.write(${JSON.stringify(JSON.stringify(final))}),150)`],
    { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  const observation = new TurnObservation(0, "claude-sonnet-5-5");
  let raw: typeof final | undefined;
  const process = observeSurfaceProcess(child, join(root, "stdout.jsonl"), value => {
    observation.observe(value); if (value.type === "result") raw = value as typeof final;
  });
  try {
    try { for await (const _chunk of process.stdout) throw Error("controlled early SDK rejection"); } catch { /* native drain continues */ }
    expect(raw).toBeUndefined();
    expect(() => successfulSurfaceReceipt(raw, observation)).toThrow("missing_success_result");
    expect(await exited).toBe(0);
    expect(raw).toEqual(final);
    expect(() => successfulSurfaceReceipt(raw, observation)).toThrow("Missing model usage");
    expect(readFileSync(join(root, "stdout.jsonl")).equals(Buffer.from(bytes))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
