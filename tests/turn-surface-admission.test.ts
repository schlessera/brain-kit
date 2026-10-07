import { expect, test } from "bun:test";
import { SurfaceAdmission } from "../scripts/turn-surface-admission";
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
