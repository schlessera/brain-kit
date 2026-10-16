/** Keyless same-byte native serialization control; caller supplies offline netns. */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { captureSurface } from "../../scripts/capture-turn-surface.js";
import { observedSkills } from "../../scripts/turn-surface-skills.js";

const networkInterfaces = readFileSync("/proc/net/dev", "utf8").trim().split("\n").slice(2).map(line => line.split(":")[0]!.trim());
assert.deepEqual(networkInterfaces, ["lo"], "OWNED_CLAUDE_REQUIRES_OFFLINE_NAMESPACE");
const root = resolve(import.meta.dir, "../../tmp"); mkdirSync(root, { recursive: true });
const outside = mkdtempSync(join(root, "odysseus-cli-placement-"));
const inside = mkdtempSync(join(tmpdir(), "odysseus-cli-placement-"));
const sdk = dirname(Bun.resolveSync("@anthropic-ai/claude-agent-sdk", join(import.meta.dir, "../../packages/ui-backend-claude/src")));
const installed = join(sdk, `node_modules/@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`);
try {
  const paths = [outside, inside].map(root => {
    writeFileSync(join(root, "package.json"), '{"name":"odysseus-owned-cli-control"}\n');
    const path = join(root, "claude"); copyFileSync(installed, path); return path;
  });
  const digest = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
  const installedDigest = digest(installed), runtimeDigests = paths.map(digest);
  assert.deepEqual(runtimeDigests, [installedDigest, installedDigest], "OWNED_CLAUDE_NATIVE_BYTES_MATCH");
  const results = [];
  for (const path of paths) {
    const result = await captureSurface(undefined, path);
    assert.equal(result.evidence, "offline-installed-cli-serialization", "OWNED_CLAUDE_REQUEST_CAPTURED");
    assert.equal(result.cliVersion, result.runtime.claudeCode);
    assert(result.request.tools.some(tool => tool.name === "Read"));
    assert(result.request.tools.some(tool => tool.name === "mcp__brain-ui__show_block"));
    assert(JSON.stringify(result.request.messages).includes("Explain what a mast does."));
    for (const skill of result.fixtureSkills) assert(observedSkills(result.request).some(entry => entry.name === skill.name && entry.description === skill.description));
    results.push(result);
  }
  assert.deepEqual(observedSkills(results[0]!.request), observedSkills(results[1]!.request));
  assert.deepEqual(results[0]!.request.tools.map(tool => tool.name), results[1]!.request.tools.map(tool => tool.name));
  console.log(JSON.stringify({ networkInterfaces, placements: paths.length, measuredRequests: results.length, installedDigest, runtimeDigests,
    installedVersion: results[0]!.runtime.claudeCode, cliVersions: results.map(result => result.cliVersion) }));
} finally { rmSync(outside, { recursive: true, force: true }); rmSync(inside, { recursive: true, force: true }); }
