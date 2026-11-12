/**
 * The executor's mandatory egress route (#3687): inside its boundary there is
 * no network but the host egress proxy, so a direct socket, a spawned curl and
 * a proxy-bypass setting reach nothing, while the route itself works.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { startEgressProxy } from "@schlessera/brain-ui-sdk/internal";
import { prepareWebExecutorState } from "../src/internal.js";
import { webExecutorBoundary } from "../src/web-executor.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const step of cleanup.splice(0).reverse()) step(); });

/** A host address outside loopback: what a namespace-less process could reach directly. */
function hostAddress(): string | undefined {
  return Object.values(networkInterfaces()).flat().find(entry => entry && entry.family === "IPv4" && !entry.internal)?.address;
}

test("inside the executor boundary only the egress route reaches anything", async () => {
  const address = hostAddress();
  expect(address, "a non-loopback host address is needed to prove the namespace").toBeDefined();
  // Listens on every address: reachable directly by anything that has the host's network.
  const outside = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("Odysseus outside the boundary") });
  cleanup.push(() => outside.stop(true));
  const root = mkdtempSync(join(tmpdir(), "odysseus-web-egress-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "web-search.json"), "{}");
  const egress = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 1 << 20, observe: () => {},
    destinations: { ports: [outside.port!], allowRanges: ["127.0.0.0/8"], lookup: async () => [{ address: "127.0.0.1", family: 4 }] } });
  cleanup.push(() => egress.stop());
  const state = prepareWebExecutorState({ root: join(root, "state"), hostConfigPath: join(root, "web-search.json"), credentialEnv: {}, path: process.env.PATH! });
  const probe = Bun.spawn(webExecutorBoundary(process.execPath, state.dir, { proxyDir: egress.dir },
    [join(import.meta.dir, "fixtures/web-egress-probe.ts"), address!, String(outside.port), `http://harbour.odysseus.test:${outside.port}/`]),
    { env: state.env, cwd: join(state.dir, "work"), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(probe.stdout).text(), new Response(probe.stderr).text(), probe.exited]);
  expect(code, err).toBe(0);
  const outcome = JSON.parse(out.trim().split("\n").at(-1)!);
  expect(outcome.socket, "WEB_EGRESS_DIRECT_SOCKET_REFUSED").toStartWith("refused:");
  expect(outcome.curl, "WEB_EGRESS_CURL_BYPASS_REFUSED").toStartWith("refused:");
  expect(outcome.bypass, "WEB_EGRESS_NO_PROXY_BYPASS_REFUSED").toStartWith("refused:");
  expect(outcome.routed, "WEB_EGRESS_ROUTE_WORKS").toBe("200:Odysseus outside the boundary");
});
