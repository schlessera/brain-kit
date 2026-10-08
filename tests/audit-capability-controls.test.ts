import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { execPath } from "node:process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { protectedReviewPrompt } from "../scripts/evals/audit-capabilities/review";
import { reviewEnvironment } from "../scripts/evals/note-disposition/review";
import { MODEL } from "../scripts/evals/audit-capabilities/protocol";
import { join } from "node:path";
import { cases, detect, prepareBenchmark } from "../scripts/evals/audit-capabilities/benchmark";
import { observeArm } from "../scripts/evals/audit-capabilities/live";
import { assertSourceEffect, sourceSnapshot } from "../scripts/evals/audit-capabilities/effects";
import { drainReviewChild } from "../scripts/evals/audit-capabilities/review-drain";

test("actual current command binary write stops before the next arm admission", async () => {
  const f = cases.find(f => f.id === "menelaus-quoted-order")!; const p = await prepareBenchmark(f);
  let physical = 0, admitted = 0;
  try {
    const detected = await detect(p);
    await expect((async () => {
      for (const arm of ["actual-current-message-only", "actual-providerless"] as const) {
        admitted++;
        await observeArm(p, f, arm, detected, { id: "offline-observed-command", capabilities: { vision: false }, async complete() { physical++; writeFileSync(join(p.root, "unexpected.bin"), Buffer.from([0, 255, 128])); return "[]"; } });
      }
    })()).rejects.toThrow("Unexpected source file membership");
    expect(physical).toBe(1); expect(admitted).toBe(1);
  } finally { p.close(); }
});

test("all-file observer refuses preserved-byte timestamp/mode changes, new directories and SQL symlinks", async () => {
  for (const change of ["mtime", "mode", "directory", "symlink"] as const) {
    const f = cases[0]!; const p = await prepareBenchmark(f);
    try {
      const before = sourceSnapshot(p.root); const path = Object.keys(f.files)[0]!;
      if (change === "mtime") utimesSync(join(p.root, path), 1, 1);
      if (change === "mode") chmodSync(join(p.root, path), 0o600);
      if (change === "directory") mkdirSync(join(p.root, "unexpected-empty"));
      if (change === "symlink") { rmSync(join(p.root, "brain.db-shm"), { force: true }); symlinkSync(path, join(p.root, "brain.db-shm")); }
      expect(() => assertSourceEffect(before, sourceSnapshot(p.root), f.files)).toThrow("Unexpected source");
    } finally { p.close(); }
  }
});

test("native reviewer drain kills an owned child ignoring SIGTERM and awaits actual close", async () => {
  const child = spawn(execPath, ["-e", 'process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},10)'], { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
  let closed = false, watchdogFired = false; const status: { signal: string | null } = { signal: null };
  const done = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", (_code, signal) => { closed = true; status.signal = signal; resolve(); }); });
  const ready = new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); });
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await ready; child.kill("SIGTERM");
    watchdog = setTimeout(() => { watchdogFired = true; child.kill("SIGKILL"); }, 500);
    const drained = await drainReviewChild(child, done, 20);
    expect(watchdogFired).toBe(false); expect(drained.forcedKill).toBe(true); expect(closed).toBe(true); expect(status.signal).toBe("SIGKILL");
  } finally { clearTimeout(watchdog); if (!closed) { child.kill("SIGKILL"); await done; } }
});

test("actual installed reviewer CLI refuses API authentication before releasing prompt or inference", async () => {
  const home = mkdtempSync(join(tmpdir(), "brain-841-auth-control-")); let requests = 0, sentPrompt = false; const startupPaths: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { const path = new URL(request.url).pathname; if (path === "/v1/messages") requests++; else startupPaths.push(path); return Response.json({ type: "message", id: "offline-message", role: "assistant", model: MODEL, content: [{ type: "text", text: "APPROVED" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }); } });
  const env = reviewEnvironment(process.env, home, "controlled-noncredential");
  delete env.CLAUDE_CODE_OAUTH_TOKEN; env.ANTHROPIC_API_KEY = "controlled-offline-api-key"; env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.port}`;
  const receipt: any = { promptReleased: false }; const abort = new AbortController();
  let resolveHandle!: (q: any) => void; const handle = new Promise(resolve => resolveHandle = resolve);
  let owned: ReturnType<typeof spawn> | undefined, closed: Promise<void> | undefined; let exit: number | null | undefined;
  const deadline = setTimeout(() => abort.abort(), 5000); let q: ReturnType<typeof query> | undefined;
  try {
    q = query({ prompt: protectedReviewPrompt(handle, "Read-only fictional corpus review", receipt, () => {}, abort), options: { cwd: home, settingSources: [], persistSession: false, model: MODEL, tools: [], mcpServers: {}, maxTurns: 1, abortController: abort, env,
      spawnClaudeCodeProcess(options) {
        const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"] }); owned = child;
        const originalWrite = child.stdin!.write.bind(child.stdin);
        child.stdin!.write = ((chunk: any, ...args: any[]) => { if (String(chunk).includes('"type":"user"')) sentPrompt = true; return (originalWrite as any)(chunk, ...args); }) as any;
        child.stderr!.on("data", () => {}); closed = new Promise(resolve => child.once("close", code => { exit = code; resolve(); })); return child;
      } } });
    resolveHandle(q); try { for await (const _frame of q) { /* native frames are consumed, never inference-authorizing */ } } catch { /* expected protected refusal */ }
  } finally {
    clearTimeout(deadline); q?.close(); if (owned && closed) await drainReviewChild(owned, closed, 50); await server.stop(true); rmSync(home, { recursive: true, force: true });
  }
  expect(receipt.credentials).toBeDefined(); expect(sentPrompt).toBe(false); expect(receipt.promptReleased).toBe(false); expect(requests).toBe(0); expect(exit).not.toBeUndefined(); expect(startupPaths.every(path => path === "/api/hello")).toBe(true);
});
