/**
 * Web call admission (#3687): who receives a web call's content, whether the
 * conversation may send it there (G2), and how an executor connection is
 * attributed to the call in flight. The real executor proves the same rules
 * end to end (`web-pi-executor.test.ts`); these are the cases it cannot reach.
 */
import { expect, test } from "bun:test";
import { EgressAdmissionRefused } from "@schlessera/brain-ui-sdk/internal";
import type { WebBroker, WebCallAuthority, WebCallRefusal, WebCallScope, WebInFlightCall } from "../src/web-tools/broker.js";
import { admitConnection } from "../src/web-tools/host.js";
import { configuredWebHosts, webHostRecipient, webProviderRecipient } from "../src/web-tools/recipients.js";
import { webRoutingRefusal } from "../src/web-tools/routing.js";

test("each curated provider and its API hosts name one recipient; anything else is a page", () => {
  expect(["exa", "duckduckgo", "brave", "jina", "perplexity", "tavily", "openai", "gemini", "firecrawl", "kagi"].map(webProviderRecipient))
    .toEqual(["exa", "duckduckgo", "brave", "jina", "perplexity", "tavily", "openai", "google", "firecrawl", "kagi"]);
  expect(webProviderRecipient("serper"), "an uncatalogued id names itself, which no rule allows by accident").toBe("serper");
  expect(webHostRecipient("api.exa.ai")).toBe("exa");
  expect(webHostRecipient("R.JINA.AI."), "WEB_READER_FALLBACK_IS_JINA").toBe("jina");
  expect(webHostRecipient("generativelanguage.googleapis.com"), "WEB_NESTED_MODEL_IS_GOOGLE").toBe("google");
  expect(webHostRecipient("harbour.ithaca.example")).toBeUndefined();
  expect(webHostRecipient("exa.ai"), "a vendor's other host is a page").toBeUndefined();
  const configured = configuredWebHosts({ exaBaseUrl: "https://exa.odysseus.test:8443", firecrawlBaseUrl: "https://crawl.odysseus.test", jinaApiKey: "x" });
  expect(webHostRecipient("exa.odysseus.test", configured), "WEB_CONFIGURED_BASE_URL").toBe("exa");
  expect(webHostRecipient("crawl.odysseus.test", configured)).toBe("firecrawl");
  expect(configuredWebHosts({ exaBaseUrl: "not a url" }).size).toBe(0);
});

test("data routing: unrestricted, allowed, unproven and conflicting recipients", () => {
  const rule = { paths: ["notes/**"], allow: ["anthropic", "exa"] };
  const shown = [{ recipient: "anthropic", visible: ["notes"], hidden: [] }];
  expect(webRoutingRefusal({ providers: [] }, undefined, undefined, "brave"), "no rule restricts anything").toBeNull();
  expect(webRoutingRefusal({ providers: [rule] }, undefined, shown, "exa"), "a recipient the rule allows").toBeNull();
  expect(webRoutingRefusal({ providers: [rule] }, undefined, shown, "brave")?.code, "WEB_ROUTING_CONFLICT").toBe("policy_denied");
  expect(webRoutingRefusal({ providers: [rule] }, undefined, [{ recipient: "anthropic", visible: ["notes"], hidden: ["notes"] }], "brave"),
    "a folder that stayed masked was never shown").toBeNull();
  expect(webRoutingRefusal({ providers: [rule] }, undefined, [], "brave"), "nothing shown yet").toBeNull();
  // An unknown never becomes clean.
  expect(webRoutingRefusal({ providers: [rule] }, undefined, undefined, "brave")?.code, "WEB_ROUTING_EXPOSURE_UNKNOWN").toBe("policy_denied");
  expect(webRoutingRefusal({ providers: [{ paths: ["notes/*.md"], allow: [] }] }, undefined, [], "brave")?.code, "WEB_ROUTING_UNEXPRESSIBLE_SELECTOR").toBe("policy_denied");
  expect(webRoutingRefusal({ providers: [{ paths: [], types: ["journal"], allow: [] }] }, undefined, [], "brave")?.code, "WEB_ROUTING_TYPES_UNTRANSLATED").toBe("policy_denied");
  expect(webRoutingRefusal({ providers: [{ paths: [], types: ["journal"], allow: [] }] }, { journal: ["journal"] }, shown, "brave")).toBeNull();
});

const scope = (turnId: string): WebCallScope => ({ principalId: "p-penelope", sessionId: "s-ithaca", turnId, toolCallId: "t1", profile: "governed", policyRevision: null });
function inFlight(turnId: string, refusal: WebCallRefusal | null, log: string[]): WebInFlightCall {
  const authority: WebCallAuthority = { admit: async recipient => { log.push(`admit:${recipient}`); return refusal; }, attempt: event => { log.push(`attempt:${event.host}:${event.callId}`); } };
  return { callId: `call-${turnId}`, tool: "web_search", scope: scope(turnId), authority, refuse: given => { log.push(`refused:${given.code}`); } };
}
const brokerWith = (calls: WebInFlightCall[]) => ({ inFlight: () => calls }) as unknown as WebBroker;
const owner = { principalId: "p-penelope", sessionId: "s-ithaca" };

test("an executor connection belongs to the call in flight, or is refused", async () => {
  const log: string[] = [];
  await expect(admitConnection(brokerWith([]), owner, "harbour.ithaca.example", new Map()), "WEB_NO_CALL_NO_CONNECTION").rejects.toBeInstanceOf(EgressAdmissionRefused);
  await admitConnection(brokerWith([inFlight("turn-1", null, log)]), owner, "harbour.ithaca.example", new Map());
  expect(log, "a page asks no authority").toEqual([]);
  await admitConnection(brokerWith([inFlight("turn-1", null, log), inFlight("turn-1", null, log)]), owner, "api.exa.ai", new Map());
  expect(log, "WEB_PROVIDER_ADMITTED_AND_COUNTED_ONCE").toEqual(["admit:exa", "attempt:api.exa.ai:call-turn-1"]);
  log.length = 0;
  await expect(admitConnection(brokerWith([inFlight("turn-1", null, log), inFlight("turn-2", null, log)]), owner, "api.exa.ai", new Map()),
    "WEB_AMBIGUOUS_TURN_REFUSED").rejects.toBeInstanceOf(EgressAdmissionRefused);
  expect(log).toEqual([]);
  const denied = { code: "budget_exceeded" as const, message: "Turn inference budget reached." };
  await expect(admitConnection(brokerWith([inFlight("turn-1", denied, log), inFlight("turn-1", denied, log)]), owner, "api.exa.ai", new Map())).rejects.toBeInstanceOf(EgressAdmissionRefused);
  expect(log, "WEB_REFUSAL_SETTLES_EVERY_CALL_IN_FLIGHT").toEqual(["admit:exa", "refused:budget_exceeded", "refused:budget_exceeded"]);
  log.length = 0;
  const broken = inFlight("turn-1", null, log);
  broken.authority!.admit = async () => { throw new Error("ledger closed"); };
  await expect(admitConnection(brokerWith([broken]), owner, "api.exa.ai", new Map())).rejects.toBeInstanceOf(EgressAdmissionRefused);
  expect(log, "WEB_ADMISSION_FAILURE_REFUSES").toEqual(["refused:unavailable"]);
});
