import { Hono } from "hono";
import { protectedPaths } from "@schlessera/brain-common/internal/protected-paths";
import type { AgentPolicyRead, WorkerLimitsStatus } from "@schlessera/brain-ui-sdk/protocol";
import type { AppEnv } from "../app-env.js";
import type { WsHost } from "../ws/host.js";
/** Same admission cache; policy budgets/scope values are not represented as enforcing limits. */
export function createAgentPolicyRoutes(host: WsHost, workerLimits: () => WorkerLimitsStatus | null): Hono<AppEnv> {
  return new Hono<AppEnv>().get("/agent-policy", c => {
    c.header("Cache-Control", "no-store");
    if (!c.get("principal")) return c.json({ error: "Authentication required", authRequired: true }, 401);
    const turns = host.governedTurns;
    if (!turns?.facts) return c.json({ error: "Policy facts are not available on this host." }, 503);
    const interactive = turns.facts("interactive"), voice = turns.facts("voice");
    if (interactive.policy.hash !== voice.policy.hash || interactive.policy.source !== voice.policy.source)
      return c.json({ error: "The policy changed while its facts were read. Open Settings again." }, 503);
    const policy = interactive.policy;
    const result: AgentPolicyRead = { path: "context/policies/governance.md", hash: policy.hash, source: policy.source,
      errors: [...policy.errors], warnings: [...policy.warnings], profiles: { interactive: interactive.policyProfile, voice: voice.policyProfile },
      protectedPaths: protectedPaths(policy.policy), workerLimits: workerLimits() };
    return c.json(result);
  });
}
