/** Root-controlled direct-native reviewer. Offline controls never grant approval. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { bundledClaudeBinary } from "../../../../core/src/providers/agents/claude-binary";
import { claudeRunner } from "../../../../core/src/providers/agents/cli-runners";
import { frozenBinding, runtimeIdentity, ROOT } from "./binding";
import { sha } from "./adapter";
import { ReviewBudget, validatePaidPolicy, type RootPaidPolicy, type ReviewBinding } from "./paid-policy";
import { saveEvidenceBundle, type ExecutionEvidence } from "./review-evidence";
import { startRelay } from "./review-relay";
import { consumeGrant } from "./grant";
export async function runReview(options: { output: string; prompt: string; token: string; policy: RootPaidPolicy; policySha: string; binding: ReviewBinding;
  sidecar?: string; offline?: boolean; offlineFetch?: (url: string, init: RequestInit) => Promise<Response>; offlineDeadlineMs?: number }) {
  if (options.offline) {
    if (process.env.BRAIN_TRIAGE_REVIEW_OFFLINE !== "1" || !options.offlineFetch || readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1).some(r => r.trim().split(/\s+/)[0] !== "lo"))
      throw Error("Offline review requires networkless namespace and fake upstream");
  } else if (options.offlineFetch || process.env.BRAIN_TRIAGE_REVIEW_DISPATCH !== "848-root-paid-approved" || !options.sidecar) throw Error("Explicit root live admission required; injected transport refused");
  const bound = options.offline ? null : frozenBinding(options.sidecar!);
  if (bound && (JSON.stringify(bound.binding) !== JSON.stringify(options.binding) || bound.prompt !== options.prompt)) throw Error("Literal current review binding mismatch");
  if (sha(options.prompt) !== options.binding.promptSha || sha(JSON.stringify(options.policy)) !== options.policySha) throw Error("Prompt/root policy changed");
  validatePaidPolicy(options.policy, options.binding);
  const runtime = runtimeIdentity(); if (sha(JSON.stringify(runtime)) !== options.binding.runtimeSha) throw Error("Policy runtime mismatch");
  if (!options.token || existsSync(options.output)) throw Error("Protected fresh output and supplied OAuth route required");
  const startedAtUtc = new Date().toISOString(), grant = consumeGrant(options.policy, options.binding);
  mkdirSync(options.output, { mode: 0o700 });
  writeFileSync(join(options.output,"grant.json"),readFileSync(options.policy.consumedMarkerPath),{mode:0o600});
  const home = join(options.output, "home"), cwd = join(options.output, "empty-project"); mkdirSync(home, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
  const execution: ExecutionEvidence = { kind: options.offline ? "offline-native-scripted" : "subscription-native-direct", transport: options.offline ? "injected-offline-fetch" : "global-fetch",
    upstream: "https://api.anthropic.com/v1/messages", freezeSha: options.binding.freezeSha, promptSha: options.binding.promptSha, readOnlyReview: true, runtime,
    relayClosed: false, runnerFailure: null, additionalBilledUsd: null, startedAtUtc, grantClaimSha: grant.sha, paidAdmission: { policy: structuredClone(options.policy), entries: [] } };
  const save = () => writeFileSync(join(options.output, "execution.json"), JSON.stringify(execution, null, 2), { mode: 0o600 }); save();
  const budget = new ReviewBudget(options.policy, options.binding, entries => { execution.paidAdmission!.entries = entries; save(); });
  const policyPath = join(options.output, "root-policy.json"); writeFileSync(policyPath, JSON.stringify(options.policy), { mode: 0o600 });
  const physicalPath = join(options.output, "physical.json"); writeFileSync(physicalPath, "[]", { mode: 0o600 });
  const relay = startRelay({ oauthToken: options.token, fetch: options.offlineFetch ?? globalThis.fetch, budget,
    offline: options.offline === true, sidecar: options.sidecar,
    grant: { copyPath: join(options.output,"grant.json"),sha:grant.sha,startedAtUtc },
    save: calls => writeFileSync(physicalPath, JSON.stringify(calls, null, 2), { mode: 0o600 }) });
  const savedEnv = { ...process.env }; for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: `/usr/bin:/bin:${join(process.execPath, "..")}`, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), TERM: "dumb", NO_PROXY: "127.0.0.1,localhost",
    BRAIN_ROOT: cwd, BRAIN_LIVE_EVAL: "848", BRAIN_TRIAGE_REVIEW_READONLY_REVIEW: "1", BRAIN_TRIAGE_REVIEW_SOURCE: ROOT,
    BRAIN_TRIAGE_REVIEW_RECEIPT: join(options.output, "native.json"), BRAIN_TRIAGE_REVIEW_NATIVE_COMMAND: JSON.stringify([bundledClaudeBinary()]),
    BRAIN_TRIAGE_REVIEW_POLICY: policyPath, BRAIN_TRIAGE_REVIEW_POLICY_SHA: options.policySha, BRAIN_TRIAGE_REVIEW_BINDING: JSON.stringify(options.binding),
    BRAIN_TRIAGE_REVIEW_GRANT_PATH: join(options.output,"grant.json"), BRAIN_TRIAGE_REVIEW_GRANT_SHA: grant.sha, BRAIN_TRIAGE_REVIEW_STARTED_AT: startedAtUtc,
    CLAUDE_CODE_PATH: join(import.meta.dir, "review-observer.ts"), CLAUDE_CODE_OAUTH_TOKEN: options.token, ANTHROPIC_BASE_URL: relay.url, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...(options.offline ? { BRAIN_TRIAGE_REVIEW_OFFLINE: "1", BRAIN_TRIAGE_REVIEW_OBSERVER_DEADLINE_MS: String(options.offlineDeadlineMs ?? 20000) } : {}) });
  try { await claudeRunner().run(options.prompt, { cwd, timeoutMs: options.offline ? 25000 : 300000 }); }
  catch (error) { execution.runnerFailure = String(error); }
  finally { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, savedEnv); await relay.stop(); execution.relayClosed = true; save(); }
  const evidence = saveEvidenceBundle(options.output), native = JSON.parse(readFileSync(join(options.output, "native.json"), "utf8"));
  const complete = relay.complete() && !execution.runnerFailure && !native.failure && !native.termination && native.exitCode === 0 && native.signalCode === null &&
    native.finished === true && native.drained === true && native.stdoutComplete === true && native.stderrDrained === true && native.result?.is_error === false;
  return { evidence, execution, native, calls: relay.calls, callsComplete: relay.complete(), complete, budget: budget.entries };
}
if (import.meta.main) {
  const [sidecar, policyPath, policySha, output] = process.argv.slice(2);
  if (!sidecar || !policyPath || !policySha || !output) throw Error("Provide frozen sidecar, root policy, literal policy SHA and fresh output");
  const stat = lstatSync(policyPath); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error("Root policy must be private literal file");
  const policy = JSON.parse(readFileSync(policyPath, "utf8")), bound = frozenBinding(sidecar);
  const result = await runReview({ sidecar, output, policy, policySha, binding: bound.binding, prompt: bound.prompt, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "" });
  console.log(JSON.stringify({ output, executionKind: result.execution.kind, calls: result.calls.length, callsComplete: result.callsComplete,
    nativeExit: result.native.exitCode, nativeDrained: result.native.drained, invoiceUsd: null }));
  if (!result.complete) process.exitCode = 1;
}
