import { assertLoadedSdk, canonicalModelId } from "@schlessera/brain-ui-sdk/internal";
import { assertVersionRequirements, validateVersionMinimum, type BackendVersionRequirements, type VersionRequirement } from "@schlessera/brain-ui-sdk/server";

const OWNER = "@schlessera/brain-backend-claude";
// No backend-wide floor. Model minima follow evidenced upstream feature
// requirements; MEASURED_RUNTIME is not a compatibility requirement.
const MIN_CLAUDE_CODE_VERSION: string | undefined = undefined;

export function assertClaudeSdk(requirements: BackendVersionRequirements | undefined, phase: string) {
  return assertLoadedSdk({ owner: OWNER, ownerManifest: new URL("../package.json", import.meta.url),
    name: "@anthropic-ai/claude-agent-sdk", entry: import.meta.resolve("@anthropic-ai/claude-agent-sdk"),
    ...(requirements?.sdk !== undefined ? { minimum: requirements.sdk } : {}), phase });
}

export function claudeRuntimeRequirements(requirements?: BackendVersionRequirements, phase = "backend construction", model?: string): VersionRequirement[] {
  const result: VersionRequirement[] = [];
  if (MIN_CLAUDE_CODE_VERSION !== undefined) result.push({ owner: OWNER, kind: "minimum", declaration: MIN_CLAUDE_CODE_VERSION });
  // https://code.claude.com/docs/en/model-config#model-aliases requires this
  // CLI version for Haiku 5.5, including explicit external binary overrides.
  if (canonicalModelId(model ?? "") === "claude-haiku-5-5") {
    result.push({ owner: "claude-haiku-5-5 model", kind: "minimum", declaration: "2.1.293" });
  }
  if (requirements?.runtime !== undefined) result.push({ owner: "host versionRequirements.runtime", kind: "minimum", declaration: requirements.runtime });
  for (const req of result) {
    try { validateVersionMinimum(req.declaration, req.owner, "claude-code"); } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} ${OWNER} runtime (claude-code) during ${phase}; required ${req.owner} minimum ${JSON.stringify(req.declaration)}; detected unknown (not probed). Correct the runtime requirement and retry.`);
    }
  }
  return result;
}

export function assertClaudeRuntime(version: string | null, requirements: readonly VersionRequirement[], phase: string, unknownReason?: string): void {
  // Probe identities must be strict even when no numeric runtime floor exists.
  if (!requirements.length && version !== null) validateVersionMinimum(version, OWNER, `claude-code during ${phase}`);
  assertVersionRequirements({ identity: `${OWNER} runtime (claude-code)`, version, requirements, phase,
    action: "Install/select a compatible Claude Code executable, or correct the host runtime minimum and retry.",
    ...(unknownReason ? { unknownReason } : {}) });
}
