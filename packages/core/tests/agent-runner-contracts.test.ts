/**
 * Every built-in agent runner through the published AgentRunner contract
 * suite (#342), against stand-in CLIs — never a real agent.
 *
 * The runners spawn `codex`, `gemini` and `pi` by name, and Bun resolves a
 * bare command against the `PATH` the process started with: setting
 * `process.env.PATH` in a test does not redirect it, and the real CLI runs.
 * So the suite runs in a child `bun test` (agent-runner-contracts.run.ts)
 * whose `PATH` holds only the stand-ins, and this test asserts that every
 * case in it passed.
 */

import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_RUNNERS } from "../src/lib/registry";

const binDir = mkdtempSync(join(tmpdir(), "brain-runner-contract-bin-"));
afterAll(() => rmSync(binDir, { recursive: true, force: true }));

/** Holds "echo" or "hang"; the child's harness writes it before each case. */
const modeFile = join(binDir, "mode");

function writeBin(name: string, source: string): string {
  const path = join(binDir, name);
  writeFileSync(path, `#!${process.execPath}\n${source}`);
  chmodSync(path, 0o755);
  return path;
}

const hangs = `(await import("node:fs")).readFileSync(${JSON.stringify(modeFile)}, "utf8") === "hang"`;

// codex, gemini and pi take the prompt as their last argument.
const argvAgent = `
if (${hangs}) setTimeout(() => process.exit(1), 30_000);
else process.stdout.write(process.cwd() + "\\n" + process.argv.at(-1) + "\\n");
`;

// claude speaks stream-json: answer the handshake as a subscription account,
// then use one tool, say something, and answer the prompt.
const claudeAgent = `
const hang = ${hangs};
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === "control_request" && event.request.subtype === "initialize") {
      out({ type: "control_response", response: { subtype: "success", request_id: event.request_id,
        response: { account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } } } });
    } else if (event.type === "control_request" && event.request.subtype === "get_settings") {
      out({ type: "control_response", response: { subtype: "success", request_id: event.request_id,
        response: { effective: {}, sources: [] } } });
    } else if (event.type === "user") {
      if (hang) { setTimeout(() => process.exit(1), 30_000); continue; }
      out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "notes/voyages.md" } }] } });
      out({ type: "assistant", message: { content: [{ type: "text", text: "Reading the notes." }] } });
      out({ type: "result", subtype: "success", result: process.cwd() + "\\n" + event.message.content });
    }
  }
}
`;

test("every built-in agent runner passes the AgentRunner contract suite", async () => {
  for (const name of ["codex", "gemini", "pi"]) writeBin(name, argvAgent);
  const claude = writeBin("claude", claudeAgent);

  const child = Bun.spawn(
    [process.execPath, "test", "--timeout", "30000", "./tests/agent-runner-contracts.run.ts"],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PATH: binDir,
        CLAUDE_CODE_PATH: claude,
        BRAIN_CONTRACT_AGENT_MODE: modeFile,
      },
      stdout: "pipe",
      stderr: "pipe",
      // Killed if it outlives this test; the stand-ins exit on their own.
      timeout: 55_000,
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const report = `${stdout}\n${stderr}`;

  // Six cases per runner; a runner without runStreaming passes that case by
  // having nothing to check.
  const expected = Object.keys(AGENT_RUNNERS).length * 6;
  expect({ code, failed: report.match(/^\(fail\).*$/gm) ?? [] }).toEqual({ code: 0, failed: [] });
  expect(report).toMatch(new RegExp(`^\\s*${expected} pass$`, "m"));
  expect(report).toMatch(/^\s*0 fail$/m);
}, 60_000);
