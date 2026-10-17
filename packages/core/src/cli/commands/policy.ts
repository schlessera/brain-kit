import { checkGovernancePolicy } from "../../lib/governance-policy.js";
import { emit, parseArgs, UsageError } from "../io.js";
import type { CoreCommand } from "../types.js";

export const policyCommand: CoreCommand = {
  summary: "Validate the read-only governance policy without loading brain configuration",
  helpBlock: "brain policy check [--json]\n\nReads context/policies/governance.md. Unknown keys and non-tier-B releases refuse.\nMissing policy uses built-in defaults. No file is changed and no brain configuration executes.",
  async run(args, cli) {
    const { args: positional, flags } = parseArgs(args);
    if (positional.length !== 1 || positional[0] !== "check") throw new UsageError("Usage: brain policy check [--json]");
    for (const key of Object.keys(flags)) if (!["json", "human"].includes(key)) throw new UsageError(`Unsupported policy check flag: --${key}`);
    const result = checkGovernancePolicy(cli.brain.root);
    emit(cli.json, result, () => {
      console.log(`Governance policy: ${result.status}${result.content_hash ? ` (${result.content_hash})` : ""}`);
      for (const error of result.errors) console.error(error);
      for (const warning of result.warnings) console.error(`Warning: ${warning}`);
    });
    return result.ok ? 0 : 1;
  },
};
