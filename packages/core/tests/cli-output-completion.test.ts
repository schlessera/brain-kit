import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { BRAIN_BIN, cleanup, keylessEnv, makeTempBrain, runCli } from "./cli-harness";

let root: string;
const tail = "# Complete tail — Odysseus returns to Ithaca\n";
const document = "Odysseus plans a fictional route.\n".repeat(100_000) + tail;
const lastSummary = "Final voyage record — complete";
const recordCount = 24;

beforeAll(async () => {
  root = makeTempBrain({ empty: true });
  writeFileSync(join(root, "brain.config.json"), "{}");
  writeFileSync(join(root, "large.md"), document);
  mkdirSync(join(root, "notes"));
  for (let i = 0; i < recordCount; i++) {
    const summary = "Odysseus plans a fictional voyage. ".repeat(2_000)
      + (i === recordCount - 1 ? lastSummary : `Record ${i}`);
    writeFileSync(join(root, "notes", `${i}.md`),
      `---\ntype: note\ntitle: Voyage ${i}\nsummary: ${summary}\ncreated: 2026-07-01\nupdated: 2026-07-${String(i + 1).padStart(2, "0")}\n---\n\nFictional voyage ${i}.\n`);
  }
  const indexed = await runCli(root, ["index", "--json"]);
  expect(indexed.code).toBe(0);
});

afterAll(() => cleanup(root));

async function runBounded(args: string[], brainRoot = root) {
  const child = Bun.spawn([process.execPath, BRAIN_BIN, ...args], {
    env: keylessEnv(brainRoot), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

describe("CLI output completion", () => {
  test("large read retains its complete tail and exact bytes", async () => {
    const result = await runCli(root, ["read", "large.md"]);
    // The tail assertion precedes byte/whole-output checks: it is the mutation receipt.
    expect(result.stdout.endsWith(tail + "\n"), "complete read tail").toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBe(Buffer.byteLength(document + "\n"));
    expect(result.stdout).toBe(document + "\n");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(join(root, "large.md"), "utf8")).toBe(document);
  });

  test("large machine list retains its final nonempty record before parsing", async () => {
    const result = await runCli(root, ["list", "--limit", "100"]);
    // Check the last serialized record first, so truncation does not fail at JSON.parse.
    expect(result.stdout.includes("Record 0"), "complete list final record").toBe(true);
    const records = JSON.parse(result.stdout);
    expect(records).toHaveLength(recordCount);
    expect(records[0].summary.endsWith(lastSummary)).toBe(true);
    expect(records.at(-1).summary.endsWith("Record 0")).toBe(true);
    expect(records.every((r: { summary: string }) => r.summary.length > 60_000)).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(1_500_000);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("explicit human and JSON modes preserve the same complete values", async () => {
    const human = await runBounded(["read", "large.md", "--human"]);
    expect(human.stdout.endsWith(tail + "\n"), "complete forced-human tail").toBe(true);
    expect(human.stdout).toBe(document + "\n");
    expect(human.code).toBe(0);
    expect(human.stderr).toBe("");
    const machine = await runBounded(["list", "--limit", "100", "--json"]);
    const automatic = await runBounded(["list", "--limit", "100"]);
    expect(machine.stdout.includes("Record 0")).toBe(true);
    expect(machine.stdout).toBe(automatic.stdout);
    expect(machine.code).toBe(0);
    expect(machine.stderr).toBe("");
  });

  test("a slow pipe consumer drains the whole human response", async () => {
    // A paused child-process pipe supplies backpressure; delay only the consumer,
    // never the CLI's completion. stdout and stderr are consumed concurrently.
    const consumer = `
      const {spawn} = require('node:child_process');
      const child = spawn(process.execPath, process.argv.slice(1), {stdio:['ignore','pipe','pipe']});
      const chunks = []; const errors = [];
      child.stdout.on('data', chunk => {
        chunks.push(chunk); child.stdout.pause();
        setTimeout(() => child.stdout.resume(), 2);
      });
      child.stderr.on('data', chunk => errors.push(chunk));
      child.on('close', code => {
        const out = Buffer.concat(chunks);
        process.stdout.write(JSON.stringify({code, bytes:out.length,
          tail:out.subarray(-Buffer.byteLength(${JSON.stringify(tail + "\n")})).toString(),
          hash:require('node:crypto').createHash('sha256').update(out).digest('hex'),
          stderr:Buffer.concat(errors).toString(), chunks:chunks.length}));
      });
    `;
    const child = Bun.spawn([process.execPath, "-e", consumer, BRAIN_BIN, "read", "large.md", "--human"], {
      env: keylessEnv(root), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const receipt = JSON.parse(stdout);
    expect(receipt.tail, "slow consumer complete read tail").toBe(tail + "\n");
    expect(receipt.bytes).toBe(Buffer.byteLength(document + "\n"));
    expect(receipt.hash).toBe(new Bun.CryptoHasher("sha256").update(document + "\n").digest("hex"));
    expect(receipt.chunks).toBeGreaterThan(1);
    expect(receipt.code).toBe(0);
    expect(receipt.stderr).toBe("");
  });

  test("usage and internal failures retain their exit codes and stderr", async () => {
    const invalid = "Odysseus-invalid-command-".repeat(4_000) + "complete-error-tail";
    const usage = await runBounded([invalid]);
    expect(usage.stderr.endsWith("Run `brain --help` for usage information.\n"), "complete usage stderr tail").toBe(true);
    expect(usage.stderr).toBe(`Unknown command: ${invalid}\nRun \`brain --help\` for usage information.\n`);
    expect(usage.stdout).toBe("");
    expect(usage.code).toBe(1);
    const thrownUsage = await runBounded(["read"]);
    expect(thrownUsage).toEqual({stdout: "", stderr: "Usage: brain read <path>\n", code: 1});
    const internal = await runBounded(["read", "notes"]);
    expect(internal.stdout).toBe("");
    expect(internal.stderr).toContain("EISDIR");
    expect(internal.code).toBe(2);
  });

  test("ordinary output finishes despite unrelated live sockets and timers", async () => {
    const liveRoot = makeTempBrain({ empty: true });
    try {
      writeFileSync(join(liveRoot, "brain.config.ts"), `
        const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("fictional fixture")});
        setInterval(() => {}, 60_000);
        await Bun.write(new URL("./live.json", import.meta.url), JSON.stringify({port: server.port}));
        export default {};
      `);
      writeFileSync(join(liveRoot, "note.md"), "Odysseus plans a voyage.\n");
      const result = await runBounded(["read", "note.md", "--human"], liveRoot);
      expect(result).toEqual({stdout: "Odysseus plans a voyage.\n\n", stderr: "", code: 0});
      expect(JSON.parse(readFileSync(join(liveRoot, "live.json"), "utf8")).port).toBeGreaterThan(0);
      const help = await runBounded(["--help"]);
      expect(help.stdout).toContain("Usage:");
      expect(help.code).toBe(0);
      expect(help.stderr).toBe("");
    } finally {
      cleanup(liveRoot);
    }
  });
});
