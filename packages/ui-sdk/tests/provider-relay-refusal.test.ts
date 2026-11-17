/**
 * A relayed provider request the turn proxy refuses says why (#3431). The
 * real `brain image` runs with its OpenAI key withheld and the host's provider
 * relay on a socket; the relay shares a real turn proxy on loopback. Before
 * #3431 the CLI printed "Provider network admission refused (region not
 * supported, or the org is not verified)", and the agent blamed the account.
 * No sandbox: the relay and proxy are what is under test, and the fictional
 * upstream is never reached because the proxy refuses it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startEgressProxy, type EgressRecord } from "../src/server/egress-proxy.js";
import { startProviderRelay, type ProviderRelayRefusal } from "../src/server/provider-relay.js";

const ROOT = resolve(import.meta.dir, "../../..");
const BRAIN_CLI = join(ROOT, "packages/core/src/cli/brain.ts");
const HOST_KEY = "odysseus-host-openai-key";
let upstream: ReturnType<typeof Bun.serve>;
let reply: () => Response = () => Response.json({ data: [] });
const seen: string[] = [];
let root: string, brain: string;

beforeAll(() => {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { seen.push(new URL(request.url).pathname); return reply(); } });
  mkdirSync(join(ROOT, "tmp"), { recursive: true });
  root = mkdtempSync(join(ROOT, "tmp/provider-relay-refusal-"));
  brain = join(root, "brain");
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, "brain.config.ts"), `import { defineConfig } from "@schlessera/brain";
export default defineConfig({ modules: { "@schlessera/brain-module-images": {} } });
`);
});
afterAll(() => { upstream.stop(true); rmSync(root, { recursive: true, force: true }); });

/** `brain image` in a worker-like environment: key withheld, relay socket given, the turn proxy behind the relay. */
async function image(proxy: { deny?: string[]; mode?: "record" | "allowlist" }) {
  const records: EgressRecord[] = [], refusals: ProviderRelayRefusal[] = [];
  const egress = await startEgressProxy({ mode: proxy.mode ?? "record", allow: [], deny: proxy.deny ?? [], maxBytes: 64 * 1024 * 1024,
    outwardHosts: [], observe: record => records.push(record) });
  const relay = startProviderRelay({ egress, credential: name => name === "OPENAI_API_KEY" ? HOST_KEY : undefined,
    origins: new Map([["OPENAI_API_KEY", [upstream.url.origin]]]), refused: refusal => refusals.push(refusal) });
  seen.length = 0;
  try {
    const child = Bun.spawn([process.execPath, BRAIN_CLI, "image", "Odysseus sights Ithaca at dawn", "--provider", "openai", "--out", "ithaca.png"], {
      cwd: brain, stdout: "pipe", stderr: "pipe",
      env: { PATH: "/usr/bin:/bin", HOME: root, BRAIN_ROOT: brain, BUN_OPTIONS: "--no-env-file", BRAIN_WITHHELD_KEYS: "OPENAI_API_KEY",
        BRAIN_PROVIDER_RELAY_SOCKET: relay.socketPath, OPENAI_BASE_URL: `${upstream.url.origin}/v1` } });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exit, output: `${stdout}${stderr}`, records, refusals, upstream: [...seen] };
  } finally { await relay.stop(); egress.stop(); }
}

test("a relayed image request the turn proxy refuses names the cause, without the account hint", async () => {
  const result = await image({ deny: ["127.0.0.1"] });
  expect(result.exit, result.output).not.toBe(0);
  expect(result.upstream, "RELAY_REFUSAL_NEVER_CONTACTS_PROVIDER").toEqual([]);
  expect(result.refusals.map(refusal => refusal.reason)).toEqual(["egress_refused"]);
  expect(result.output, "RELAY_REFUSAL_NAMES_CAUSE").toContain("OpenAI: Blocked: 127.0.0.1 is on this brain's egress deny list.");
  expect(result.output, "RELAY_REFUSAL_DROPS_ACCOUNT_HINT").not.toContain("region not supported");
  expect(result.output).not.toContain(HOST_KEY);
});

test("allowlist mode names the allow list", async () => {
  const result = await image({ mode: "allowlist" });
  expect(result.upstream).toEqual([]);
  expect(result.output, "RELAY_REFUSAL_NAMES_ALLOWLIST").toContain("OpenAI: Blocked: 127.0.0.1 is not on this brain's egress allow list.");
  expect(result.output).not.toContain("region not supported");
});

test("a genuine upstream 403 keeps the provider's hint", async () => {
  reply = () => Response.json({ error: { message: "Project does not have access to this model", type: "invalid_request_error" } }, { status: 403 });
  try {
    const result = await image({});
    expect(result.exit, result.output).not.toBe(0);
    expect(result.upstream, "UPSTREAM_403_WAS_CONTACTED").toEqual(["/v1/images/generations"]);
    expect(result.output, "UPSTREAM_403_KEEPS_HINT").toContain("OpenAI: Project does not have access to this model (region not supported, or the org is not verified)");
  } finally { reply = () => Response.json({ data: [] }); }
});
