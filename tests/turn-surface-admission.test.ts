import { expect, test } from "bun:test";
import { SurfaceAdmission } from "../scripts/turn-surface-admission";
import { captureSurface } from "../scripts/capture-turn-surface";
import { protectedSurfacePrompt } from "../scripts/turn-surface-prompt-gate";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
const model = "claude-sonnet-5-5", cli = "2.1.283";
const init = { type: "system", subtype: "init", model, apiKeySource: "none", claude_code_version: cli };
const account = { type: "control_response", response: { response: { account: {
  tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty", privateIdentity: "never serialize" } } } };
test("subscription selectors are retained without identity and missing/init/API routes abort", () => {
  const abort = new AbortController(), admission = new SurfaceAdmission(abort, model, cli);
  admission.observe(init); admission.observe(account); admission.requireIdentity();
  expect(abort.signal.aborted).toBe(false);
  expect(JSON.stringify(admission.account)).not.toContain("privateIdentity");
  for (const wrong of [ { ...init, model: "claude-sonnet-5" }, { ...init, apiKeySource: "ANTHROPIC_API_KEY" }, { ...init, claude_code_version: "unknown" },
    { type: "control_response", response: { response: { account: { tokenSource: "API", apiKeySource: "key", apiProvider: "firstParty" } } } } ]) {
    const controller = new AbortController(), guard = new SurfaceAdmission(controller, model, cli);
    guard.observe(wrong); expect(controller.signal.aborted).toBe(true);
    expect(() => guard.requireIdentity()).toThrow();
  }
  const missing = new SurfaceAdmission(new AbortController(), model, cli); missing.observe(init);
  expect(() => missing.requireIdentity()).toThrow("missing_native_auth_identity");
});
test("both subscription-overage spellings stop admissions and abort the current native turn", () => {
  for (const flag of ["isUsingOverage", "overageInUse"]) {
    const abort = new AbortController(), admission = new SurfaceAdmission(abort, model, cli);
    admission.observe({ type: "rate_limit_event", rate_limit_info: { [flag]: true } });
    expect(admission.stopped).toBe("subscription_overage_reported");
    expect(abort.signal.aborted).toBe(true);
  }
});
test("installed CLI API-auth handshake refuses before any model request or prompt", async () => {
  const capture = await captureSurface({ decision: Promise.resolve({ arm: "baseline", routed: false, tools: [], skills: [] }),
    testSubscriptionRefusal: true });
  expect(capture.requests).toHaveLength(0);
  expect(capture.gateRefusal).toBe("native_subscription_account_refused");
  expect(capture.frames.some(frame => frame.type === "assistant")).toBe(false);
});
test("installed CLI effective auxiliary-model setting refuses after native OAuth handshake before inference", async () => {
  const capture = await captureSurface({ decision: Promise.resolve({ arm: "baseline", routed: false, tools: [], skills: [] }),
    testPolicyModelRefusal: true });
  expect(capture.requests).toHaveLength(0);
  expect(capture.gateRefusal).toBe("native_auxiliary_model_settings_refused");
});
test("effective and policy-source credentials or auxiliary-model overrides prevent yielding a prompt", async () => {
  for (const settings of [undefined,
    { effective: {}, sources: [{ source: "policy", settings: { apiKeyHelper: "controlled helper" } }] },
    { effective: { env: { ANTHROPIC_API_KEY: "controlled fixture" } }, sources: [] },
    { effective: {}, sources: [{ source: "policy", settings: { env: { ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5" } } }] },
  ]) {
    const abort = new AbortController();
    const query = { initializationResult: async () => ({ account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } }),
      getSettings: async () => settings } as unknown as Query;
    const prompt = protectedSurfacePrompt({ query: Promise.resolve(query), prompt: "fictional prompt", abort });
    expect((await prompt.next()).done).toBe(true);
    expect(abort.signal.aborted).toBe(true);
  }
  const abort = new AbortController(); let checked = false;
  const query = { initializationResult: async () => ({ account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } }),
    getSettings: async () => ({ effective: {}, sources: [] }) } as unknown as Query;
  const prompt = protectedSurfacePrompt({ query: Promise.resolve(query), prompt: "fictional prompt", abort, onChecked: () => { checked = true; } });
  expect((await prompt.next()).value?.message.content).toBe("fictional prompt");
  expect(checked).toBe(true); expect(abort.signal.aborted).toBe(false);
});
