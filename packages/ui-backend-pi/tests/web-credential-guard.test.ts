/**
 * The web executor's credential guard (#3687): a provider key never follows a
 * redirect to another origin, whether fetch follows it or the caller does.
 * Two loopback origins (`127.0.0.1` and `localhost`) stand in for a provider
 * and the host its redirect names.
 */
import { afterEach, expect, test } from "bun:test";
import { CredentialRedirectRefused, guardCredentialRedirects, webCredentialValues } from "../src/web-credential-guard.js";

const KEY = "odysseus-guard-sentinel-key";
const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function origins() {
  const seen: Array<{ origin: string; key: string | null; auth: string | null; method: string }> = [];
  const elsewhere = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    seen.push({ origin: "elsewhere", key: request.headers.get("x-api-key"), auth: request.headers.get("authorization"), method: request.method });
    return new Response("elsewhere");
  } });
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    const path = new URL(request.url).pathname;
    seen.push({ origin: "provider", key: request.headers.get("x-api-key"), auth: request.headers.get("authorization"), method: request.method });
    if (path === "/away") return new Response(null, { status: 307, headers: { location: `http://localhost:${elsewhere.port}/collect` } });
    if (path === "/near") return new Response(null, { status: 302, headers: { location: "/done" } });
    return new Response("provider");
  } });
  servers.push(elsewhere, provider);
  return { seen, provider: `http://127.0.0.1:${provider.port}` };
}

test("a credentialed request is refused at a cross-origin redirect, header or query alike", async () => {
  const { seen, provider } = origins();
  const guarded = guardCredentialRedirects(fetch, [KEY]);
  await expect(guarded(`${provider}/away`, { method: "POST", body: "{}", headers: { "x-api-key": KEY } }), "WEB_GUARD_HEADER_KEY_REFUSED")
    .rejects.toBeInstanceOf(CredentialRedirectRefused);
  await expect(guarded(`${provider}/away?key=${KEY}`), "WEB_GUARD_QUERY_KEY_REFUSED").rejects.toBeInstanceOf(CredentialRedirectRefused);
  await expect(guarded(`${provider}/away`, { method: "POST", body: JSON.stringify({ api_key: KEY }) }), "WEB_GUARD_BODY_KEY_REFUSED")
    .rejects.toBeInstanceOf(CredentialRedirectRefused);
  expect(seen.filter(entry => entry.origin === "elsewhere"), "WEB_GUARD_NOTHING_REACHED_THE_OTHER_ORIGIN").toEqual([]);
});

test("a same-origin redirect keeps the key, and an uncredentialed cross-origin one loses its authorization", async () => {
  const { seen, provider } = origins();
  const guarded = guardCredentialRedirects(fetch, [KEY]);
  expect(await (await guarded(`${provider}/near`, { headers: { "x-api-key": KEY } })).text()).toBe("provider");
  expect(seen.at(-1)).toMatchObject({ origin: "provider", key: KEY });
  expect(await (await guarded(`${provider}/away`, { headers: { authorization: "Bearer session-cookie-standin" } })).text()).toBe("elsewhere");
  expect(seen.at(-1), "WEB_GUARD_STRIPS_AUTHORIZATION").toMatchObject({ origin: "elsewhere", auth: null });
});

test("a caller that follows redirects itself cannot re-send the key to the remembered target", async () => {
  const { seen, provider } = origins();
  const guarded = guardCredentialRedirects(fetch, [KEY]);
  const first = await guarded(`${provider}/away`, { headers: { "x-api-key": KEY }, redirect: "manual" });
  expect(first.status).toBe(307);
  await expect(guarded(new URL(first.headers.get("location")!), { headers: { "x-api-key": KEY }, redirect: "manual" }), "WEB_GUARD_MANUAL_REISSUE_REFUSED")
    .rejects.toBeInstanceOf(CredentialRedirectRefused);
  expect(seen.filter(entry => entry.origin === "elsewhere")).toEqual([]);
});

test("credential values come from the provider key variables and the configuration's key fields", () => {
  expect(webCredentialValues({ EXA_API_KEY: "odysseus-env-exa-key", PATH: "/usr/bin" }, ["EXA_API_KEY"],
    { braveApiKey: "odysseus-literal-brave", tavilyApiKey: "$TAVILY_API_KEY", tavily: { keys: ["odysseus-tavily-one"] }, workflow: "none", exaBaseUrl: "https://exa.example" }).sort())
    .toEqual(["odysseus-env-exa-key", "odysseus-literal-brave", "odysseus-tavily-one"]);
});
