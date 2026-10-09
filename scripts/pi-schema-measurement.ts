/** Private instrumentation for #563; production keeps its shipped form. */
import { showBlockInputSchema } from "../packages/ui-sdk/src/tool-contracts/blocks.ts";
import type { SchemaArm } from "./show-block-schema-forms.ts";
import { appendFileSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

// Synchronous counterpart of #336's frozen options: its MCP-listing module
// has top-level await and cannot be loaded through the server descriptor's
// actual require path. The test compares all three option/schema bytes.
export const PI_SCHEMA_ARMS = {
  flat: { sharedDefinitions: false, restatedProse: true },
  shared: { sharedDefinitions: true, restatedProse: true },
  "shared-trimmed": { sharedDefinitions: true, restatedProse: false },
} as const;

export const PI_SCHEMA_PROMPT = "Compare daily journal entries, topic notes and project notes for organizing a personal knowledge base. Give the strengths and trade-offs of each.";
export const PI_SCHEMA_REQUEST_LIMIT = 5;
export const PI_SCHEMA_MODEL = "gpt-6.1-sol";

/** Same read-only execution policy in every form; model-visible roster unchanged. */
export function measurementFixtureGuard(brain: string): InlineExtension {
  const root = realpathSync(brain), allowed = new Set(["read_file", "grep", "brain_search", "brain_context", "brain_read", "brain_list", "brain_graph", "show_block"]);
  return { name: "measurement-fixture-only", factory(pi) {
    pi.on("tool_call", async event => {
      let reason: string | null = allowed.has(event.toolName) ? null : "Measurement denies writes, shell, delegation and external capabilities.";
      const input = event.input as Record<string, unknown>;
      if (!reason && typeof input?.path === "string") {
        try { const path = realpathSync(resolve(root, input.path)); if (path !== root && !path.startsWith(root + sep)) reason = "Measurement path is outside fixture corpus."; }
        catch { reason = "Measurement path cannot be resolved inside fixture corpus."; }
      }
      const out = process.env.BRAIN_MEASURE_PI_RECEIPTS;
      if (out) appendFileSync(resolve(out, "tool-admission.jsonl"), JSON.stringify({toolName:event.toolName, input:event.input, allowed:!reason, reason}) + "\n", {mode:0o600});
      return reason ? {block:true,reason} : undefined;
    });
  }};
}

/** Fresh fixture plumbing only: immutable source runtime, no dependency sharing. */
export function stagePiFixtureRuntime(brain: string) {
  const source = new URL("../packages/core", import.meta.url).pathname.replace(/\/$/, "");
  mkdirSync(resolve(brain, "node_modules/.bin"), { recursive: true });
  mkdirSync(resolve(brain, "node_modules/@schlessera"), { recursive: true });
  symlinkSync(source, resolve(brain, "node_modules/@schlessera/brain"));
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  writeFileSync(resolve(brain, "node_modules/.bin/brain"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(`${source}/src/cli/brain.ts`)} "$@"\n`, { mode: 0o700 });
}

export function measurementForm(value: string | undefined): SchemaArm {
  if (value !== "flat" && value !== "shared" && value !== "shared-trimmed") {
    throw new Error("Select exactly flat, shared, or shared-trimmed.");
  }
  return value;
}

export function measurementSchema(value: string | undefined) {
  return showBlockInputSchema(PI_SCHEMA_ARMS[measurementForm(value)]);
}

export function nativeCredential(env: Record<string, string | undefined> = process.env) {
  const access = env.BRAIN_MEASURE_CODEX_ACCESS_TOKEN;
  const accountId = env.BRAIN_MEASURE_CODEX_ACCOUNT_ID;
  if (!access || !accountId) throw new Error("Protected native Codex credential is absent.");
  let payload: { exp?: number; [key: string]: unknown };
  try { payload = JSON.parse(Buffer.from(access.split(".")[1]!, "base64url").toString("utf8")); }
  catch { throw new Error("Native Codex credential is malformed."); }
  const claim = payload["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined;
  if (!Number.isFinite(payload.exp) || payload.exp! * 1000 <= Date.now() + 300_000 || claim?.chatgpt_account_id !== accountId) {
    throw new Error("Native Codex credential expiry/account claim mismatch.");
  }
  for (const name of ["OPENAI_API_KEY", "OPENAI_CODEX_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "TYPESAFE_API_KEY"]) {
    if (env[name]) throw new Error("Unexpected alternate billing credential.");
  }
  return { type: "oauth" as const, access, refresh: "refresh-disabled-for-measurement", expires: payload.exp! * 1000, accountId };
}

/** Public runtime credential interface, memory only; refresh writes fail closed. */
export async function createMeasurementModelRuntime() {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const credential = nativeCredential();
  const runtime = await ModelRuntime.create({
    credentials: {
      async read(id: string) { return id === "openai-codex" ? credential : undefined; },
      async list() { return [{ providerId: "openai-codex", type: "oauth" as const }]; },
      async modify() { throw new Error("Read-only measurement credential store."); },
      async delete() { throw new Error("Read-only measurement credential store."); },
    },
    modelsPath: null,
    modelsStorePath: `${process.env.PI_CODING_AGENT_DIR}/models-store.json`,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const id = process.env.BRAIN_MEASURE_CODEX_MODEL;
  if (id !== PI_SCHEMA_MODEL) throw new Error("Exact ruled Codex model required.");
  const model = id ? runtime.getModel("openai-codex", id) : undefined;
  if (!model || model.id !== id || model.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
    throw new Error("Exact ruled Codex model missing from installed runtime catalogue.");
  }
  const auth = await runtime.getAuth(model);
  if (auth?.auth.apiKey !== credential.access || auth.source !== "OAuth" || !runtime.getProvider("openai-codex")?.auth?.oauth?.isSubscription) {
    throw new Error("Native Codex subscription route mismatch.");
  }
  return runtime;
}

/** Refuse source drift rather than applying a partial measurement patch. */
export function replaceExactly(source: string, anchor: string, replacement: string, count = 1): string {
  if (source.split(anchor).length - 1 !== count) throw new Error("Measurement source anchor drift.");
  return source.split(anchor).join(replacement);
}
