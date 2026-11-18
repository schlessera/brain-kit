import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { APIFY_OPERATIONS, APIFY_TOOL_NAMES } from "@schlessera/brain-ui-sdk/tool-contracts";
import { body, captureOffline, history, identical, main, messages, pairs, system, type Captures } from "../../../tests/helpers/provider-history.js";
import { APIFY_SENTINEL as SENTINEL } from "../../ui-server/tests/fixtures/apify-host-fixture.js";

let captures: Captures & { apifyOutcome?: { calls: string[]; cards: string[]; starts: number; items: number | null } };
beforeAll(async () => { captures = await captureOffline(join(import.meta.dir, "fixtures/provider-history-apify-probe.ts")) as typeof captures; }, 180_000);

// #3162: a native Pi worker calls the fixed Apify tools through the worker pipe
// on every turn; the host's real operations answer, refusing while Apify is off
// and reviewing each remote step. Only the newest tool output differs per request.
test("Pi Apify tools reach the host and keep tools, instructions and history stable", () => {
  const capture = captures.apify!, outcome = captures.apifyOutcome!;
  expect(capture.sessions).toHaveLength(3);
  expect(new Set(capture.sessions).size).toBe(1);
  expect(main(capture).map(e => e.turn), "APIFY_PI_EVERY_STEP_IS_A_ROUND_TRIP").toEqual([0, 0, 1, 1, 1, 2, 2, 2, 2]);
  expect(capture.calls, "APIFY_PI_HOST_RECEIVES_EVERY_CALL").toEqual(["brain_apify_discover", "brain_apify_discover", "brain_apify_inspect",
    "brain_apify_prepare", "brain_apify_run", "brain_apify_results"]);
  expect(outcome.calls, "APIFY_PI_HOST_DECIDES").toEqual(["provider_disabled", "ok", "ok", "ok", "ok", "ok"]);
  expect(outcome.cards, "APIFY_PI_PER_USE_REVIEW").toEqual(["command:Apify catalog search", "command:Apify Actor inspection", "actor:Apify Actor run"]);
  expect(outcome.starts, "APIFY_PI_ONE_BOUNDED_RUN").toBe(1);
  expect(outcome.items, "APIFY_PI_BOUNDED_RESULTS").toBe(2);
  expect(JSON.stringify(messages(main(capture)[1]!).at(-1)), "APIFY_PI_DISABLED_IS_TOOL_ERROR").toContain("provider_disabled");
  for (const [a, b] of pairs(capture)) {
    identical(body(a).tools, body(b).tools, "APIFY_PI_TOOLS_STABLE");
    identical(system(a), system(b), "APIFY_PI_INSTRUCTIONS_STABLE");
    history(a, b);
  }
  const names = body(main(capture)[0]!).tools.map((tool: { name: string }) => tool.name).filter((name: string) => name.startsWith("brain_apify_"));
  expect(names, "APIFY_PI_FIXED_NAMES_IN_ORDER").toEqual(APIFY_OPERATIONS.map(operation => APIFY_TOOL_NAMES[operation]));
  for (const exchange of capture.exchanges) expect(exchange.raw, "APIFY_PI_TOKEN_NEVER_IN_PROVIDER_REQUESTS").not.toContain(SENTINEL);
});
