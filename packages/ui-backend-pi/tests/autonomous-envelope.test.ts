/**
 * Which pi profiles can cross the restricted envelope (#676). The runtime
 * proof is `tests/autonomous-containment.test.ts`; these are the refusals and
 * the selection that never reach a worker.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { INFERENCE_PLACEHOLDER } from "@schlessera/brain-ui-sdk/internal";
import { piAutonomousEnvelope } from "../src/autonomous-envelope.js";

const anthropic = { provider: "anthropic", id: "claude-sonnet-4-6", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" } as Model<any>;
const dirs: string[] = [];
const stops: Array<() => void> = [];
const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ODYSSEUS_PI_KEY: process.env.ODYSSEUS_PI_KEY };
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
});
function agentDir(files: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-autonomous-envelope-"));
  dirs.push(dir);
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
  return dir;
}

describe("pi autonomous envelope", () => {
  test("an API key from the server environment stays in the relay; the worker gets a placeholder and the base path", () => {
    process.env.ANTHROPIC_API_KEY = "sk-odysseus-real";
    const { relay, inference } = piAutonomousEnvelope(anthropic, agentDir());
    stops.push(relay.stop);
    expect(inference).toEqual({ provider: "anthropic", basePath: "", placeholder: INFERENCE_PLACEHOLDER });
    expect(JSON.stringify(inference)).not.toContain("sk-odysseus-real");
  });

  test("a provider override selects the upstream; a $NAME key reads the server environment", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ODYSSEUS_PI_KEY = "sk-odysseus-override";
    const openai = { provider: "openai", id: "gpt-odysseus", api: "openai-completions", baseUrl: "https://api.openai.com/v1" } as Model<any>;
    const { relay, inference } = piAutonomousEnvelope(openai, agentDir({ "models.json": { providers: { openai: { baseUrl: "https://gateway.example/v1", apiKey: "$ODYSSEUS_PI_KEY" } } } }));
    stops.push(relay.stop);
    expect(inference.basePath).toBe("/v1");
  });

  test.each([
    ["an unsupported provider API", { ...anthropic, api: "google-generative-ai" }, {}, "do not support the google-generative-ai"],
    ["a stored OAuth login", anthropic, { "auth.json": { anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } } }, "stored OAuth login"],
    ["a command-sourced key", anthropic, { "auth.json": { anthropic: { type: "api_key", key: "!cat ~/.secret" } } }, "command-sourced"],
    ["no key at all", anthropic, {}, "has no API key"],
    ["an Anthropic OAuth token", anthropic, { "auth.json": { anthropic: { type: "api_key", key: "sk-ant-oat-odysseus" } } }, "OAuth token cannot cross"],
    ["no declared model", undefined, {}, "declared vendor/model"],
  ] as const)("refuses %s before any relay or worker", (_name, model, files, message) => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => piAutonomousEnvelope(model as Model<any> | undefined, agentDir(files))).toThrow(message);
  });
});
