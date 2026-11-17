import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { APIFY_OPERATIONS, APIFY_TOOL_NAMES } from "@schlessera/brain-ui-sdk/tool-contracts";
import { body, captureOffline, history, identical, main, messages, pairs, system, type Captures } from "../../../tests/helpers/provider-history.js";
import { APIFY_SENTINEL as SENTINEL } from "../../ui-server/tests/fixtures/apify-host-fixture.js";
let captures: Captures & { apifyOutcome?: { calls: string[]; cards: string[]; starts: number; items: number | null } };
beforeAll(async () => { captures = await captureOffline(join(import.meta.dir, "fixtures/provider-history-apify-probe.ts")) as typeof captures; }, 180_000);

// #3162: the installed CLI calls the fixed Apify tools through its MCP route on
// every turn; the host's real operations answer, refusing while Apify is off and
// reviewing each remote step. Only the newest tool result differs per request.
test("Claude Apify tools reach the host and keep tools, system and history stable", () => {
  const capture = captures.apify!, outcome = captures.apifyOutcome!;
  expect(capture.sessions).toHaveLength(3);
  expect(new Set(capture.sessions).size).toBe(1);
  expect(main(capture).map(e => e.turn), "APIFY_CLAUDE_EVERY_STEP_IS_A_ROUND_TRIP").toEqual([0, 0, 1, 1, 1, 2, 2, 2, 2]);
  expect(capture.calls, "APIFY_CLAUDE_HOST_RECEIVES_EVERY_CALL").toEqual(["brain_apify_discover", "brain_apify_discover", "brain_apify_inspect",
    "brain_apify_prepare", "brain_apify_run", "brain_apify_results"]);
  expect(outcome.calls, "APIFY_CLAUDE_HOST_DECIDES").toEqual(["provider_disabled", "ok", "ok", "ok", "ok", "ok"]);
  expect(outcome.cards, "APIFY_CLAUDE_PER_USE_REVIEW").toEqual(["command:Apify catalog search", "command:Apify Actor inspection", "actor:Apify Actor run"]);
  expect(outcome.starts, "APIFY_CLAUDE_ONE_BOUNDED_RUN").toBe(1);
  expect(outcome.items, "APIFY_CLAUDE_BOUNDED_RESULTS").toBe(2);
  // The disabled turn's refusal is a model-readable tool error, and the roster did not change for it.
  const first = JSON.stringify(messages(main(capture)[1]!).at(-1));
  expect(first, "APIFY_CLAUDE_DISABLED_IS_TOOL_ERROR").toContain('"is_error":true');
  expect(first).toContain("provider_disabled");
  expect(capture.rosters, "APIFY_CLAUDE_ASSEMBLED_ROSTER_STABLE").toEqual([capture.rosters![0], capture.rosters![0], capture.rosters![0]]);
  for (const [a, b] of pairs(capture)) {
    identical(body(a).tools, body(b).tools, "APIFY_CLAUDE_TOOLS_STABLE");
    identical(system(a), system(b), "APIFY_CLAUDE_SYSTEM_STABLE");
    history(a, b);
  }
  const [firstAppend, ...rest] = capture.appends;
  for (const next of rest) identical(firstAppend, next, "APIFY_CLAUDE_SYSTEM_OPTION_STABLE");
  const names = body(main(capture)[0]!).tools.map((tool: { name: string }) => tool.name).filter((name: string) => name.includes("brain_apify_"));
  // The CLI orders its provider tool list itself; the set is the fixed ten.
  expect(names, "APIFY_CLAUDE_FIXED_NAMES").toEqual(APIFY_OPERATIONS.map(operation => `mcp__brain-ui__${APIFY_TOOL_NAMES[operation]}`).sort());
  for (const exchange of capture.exchanges) expect(exchange.raw.includes(SENTINEL), "APIFY_CLAUDE_TOKEN_NEVER_IN_PROVIDER_REQUESTS").toBe(false);
});
