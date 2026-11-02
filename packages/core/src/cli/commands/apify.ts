import { APIFY_OPERATIONS, type ApifyEnvelope, type ApifyOperation } from "@schlessera/brain-common/internal/apify-operations";
import { ApifyAuthorityError } from "@schlessera/brain-common/internal/apify";
import { ApifyLedgerUnavailable } from "@schlessera/brain-common/internal/apify";
import { ApifyOperationRefusal } from "@schlessera/brain-common/internal/apify";
import { createStandaloneApify, type StandaloneApify } from "../../lib/apify/standalone.js";
import { emit, parseArgs, UsageError } from "../io.js";
import type { CoreCommand } from "../types.js";

const USAGE = `brain apify <operation> [--session <name>] [--json]

  discover <words...> [--limit N]                  Search the Actor catalog
  inspect <candidate>                              Read one Actor's build, schema and price
  prepare <candidate> --input <json> --max-charge-usd <usd>
                                                   Prepare one run; starts nothing
  run <proposal>                                   Run a proposal once
  status <run>                                     A run's state
  results <run> [--cursor C] [--limit N]           One page of results
  abort <run>                                      Ask Apify to stop a run
  account [confirm <account-id>]                   The bound account; confirm a changed one

The same operations as the brain_apify_* MCP tools, under the governance
policy's apify block. Needs APIFY_TOKEN and BRAIN_APIFY_LEDGER (the shared
ledger file). Nothing is ever asked on stdin: a run needs an exact standing
grant in the policy, else it refuses as approval_required. Every operation
prints { ok, operation, data } or { ok: false, operation, error: { code,
reason, message } } and exits 0 or 1.`;

/** The test seam: a factory for the standalone service. */
export const apifyCommandDeps: { create: (root: string) => StandaloneApify } = {
  create: root => createStandaloneApify({ root }),
};

function number(flag: string, value: string | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/u.test(value.trim())) throw new UsageError(`--${flag} needs a number.`);
  return Number(value);
}

/** The operation's input, from positional words and flags; the shared schema validates it. */
function inputFor(operation: ApifyOperation, positional: string[], flags: Record<string, string | boolean>): Record<string, unknown> {
  const one = (what: string) => {
    if (positional.length !== 1) throw new UsageError(`brain apify ${operation} takes exactly one ${what}.`);
    return positional[0]!;
  };
  switch (operation) {
    case "discover": {
      if (!positional.length) throw new UsageError("brain apify discover needs a few words to search for.");
      const limit = number("limit", flags.limit);
      return { query: positional.join(" "), ...(limit !== undefined ? { limit } : {}) };
    }
    case "inspect": return { candidate: one("candidate") };
    case "prepare": {
      const candidate = one("candidate");
      if (typeof flags.input !== "string") throw new UsageError("brain apify prepare needs --input <json>.");
      let input: unknown;
      try { input = JSON.parse(flags.input); } catch { throw new UsageError("--input must be a JSON object."); }
      const cap = number("max-charge-usd", flags["max-charge-usd"]);
      if (cap === undefined) throw new UsageError("brain apify prepare needs --max-charge-usd <usd>.");
      return { candidate, input, max_charge_usd: cap };
    }
    case "run": return { proposal: one("proposal") };
    case "status": return { run: one("run handle") };
    case "abort": return { run: one("run handle") };
    case "results": {
      const limit = number("limit", flags.limit);
      return { run: one("run handle"), ...(typeof flags.cursor === "string" ? { cursor: flags.cursor } : {}), ...(limit !== undefined ? { limit } : {}) };
    }
  }
}

const ALLOWED_FLAGS: Record<ApifyOperation, readonly string[]> = {
  discover: ["limit"], inspect: [], prepare: ["input", "max-charge-usd"], run: [], status: [], results: ["cursor", "limit"], abort: [],
};

function human(envelope: ApifyEnvelope): void {
  if (!envelope.ok) {
    console.error(`Refused (${envelope.error.code}): ${envelope.error.message}`);
    return;
  }
  console.log(JSON.stringify(envelope.data, null, 2));
}

export const apifyCommand: CoreCommand = {
  summary: "Discover, inspect and run Apify Actors under the governance policy",
  helpBlock: USAGE,
  async run(args, cli) {
    const { args: positional, flags } = parseArgs(args);
    const [word, ...rest] = positional;
    if (!word) throw new UsageError(`Usage: ${USAGE.split("\n")[0]}`);
    const common = ["json", "human", "session"];
    const service = apifyCommandDeps.create(cli.brain.root);
    try {
      if (word === "account") {
        for (const key of Object.keys(flags)) if (!["json", "human"].includes(key)) throw new UsageError(`Unsupported apify account flag: --${key}`);
        if (rest.length && !(rest[0] === "confirm" && rest.length === 2)) throw new UsageError("Usage: brain apify account [confirm <account-id>]");
        try {
          const status = rest.length ? await service.confirmAccount(rest[1]!) : await service.status();
          emit(cli.json, status, () => console.log(`Apify: ${status.state}${status.reason ? ` (${status.reason})` : ""}${status.account ? `, account ${status.account.id}` : ""}`));
          return status.state === "configured" ? 0 : 1;
        } catch (error) {
          // The same fixed refusals the operations print; never upstream text.
          const refusal = error instanceof ApifyAuthorityError || error instanceof ApifyOperationRefusal ? { code: error.code, reason: error.reason, message: error.message }
            : error instanceof ApifyLedgerUnavailable ? { code: "accounting_unavailable", reason: "ledger", message: error.message } : null;
          if (!refusal) throw error;
          emit(cli.json, { ok: false, error: refusal }, () => console.error(`Refused (${refusal.code}): ${refusal.message}`));
          return 1;
        }
      }
      if (!(APIFY_OPERATIONS as readonly string[]).includes(word)) throw new UsageError(`Unknown apify operation: ${word}. ${USAGE.split("\n")[0]}`);
      const operation = word as ApifyOperation;
      for (const key of Object.keys(flags)) if (![...common, ...ALLOWED_FLAGS[operation]].includes(key)) throw new UsageError(`Unsupported apify ${operation} flag: --${key}`);
      if (flags.session !== undefined && (typeof flags.session !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(flags.session)))
        throw new UsageError("--session is 1 to 64 letters, digits, dots, dashes or underscores.");
      const envelope = await service.call(operation, inputFor(operation, rest, flags), typeof flags.session === "string" ? { session: flags.session } : {});
      emit(cli.json, envelope, () => human(envelope));
      return envelope.ok ? 0 : 1;
    } finally {
      service.close();
    }
  },
};
