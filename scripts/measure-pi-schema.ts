/** #563: three provider-acceptance probes, never a call-rate experiment. */
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createApp } from "../packages/ui-server/src/app.ts";
import { resolveServerConfig } from "../packages/ui-server/src/config/env.ts";
import { runOnce, observedRuntimeVersions, assertMeasurableBrainPath } from "./measure-show-block-server.ts";
import { PI_SCHEMA_PROMPT, PI_SCHEMA_MODEL, measurementForm, stagePiFixtureRuntime } from "./pi-schema-measurement.ts";
import { assertPiSchemaAcceptance,waitPiSchemaCaptures } from "./pi-schema-capture.ts";

const flag = (name: string) => process.argv[process.argv.indexOf(`--${name}`) + 1];
const brain = flag("brain");
const out = flag("out");
const model = process.env.BRAIN_MEASURE_CODEX_MODEL;
const form = measurementForm(process.env.BRAIN_MEASURE_PI_SCHEMA_FORM);
if (!process.argv.includes("--brain") || !process.argv.includes("--out") || !brain || !out || model !== PI_SCHEMA_MODEL) throw new Error("Provide a fresh --brain, --out and exact ruled model.");
assertMeasurableBrainPath(brain);
const path = resolve(brain);
stagePiFixtureRuntime(path);
const index = Bun.spawn([resolve(path,"node_modules/.bin/brain"),"index","--force","--json"], {cwd:path,env:process.env,stdout:"pipe",stderr:"pipe"});
const [indexOutput,indexError,indexExit]=await Promise.all([new Response(index.stdout).text(),new Response(index.stderr).text(),index.exited]);
await Bun.write(resolve(process.env.BRAIN_MEASURE_PI_RECEIPTS!,"fixture-index.json"),JSON.stringify({exit:indexExit,stdout:indexOutput,stderr:indexError},null,2));
if (indexExit !== 0) throw new Error("Fixture's actual keyless CLI index failed.");
const config = resolveServerConfig({
  ...process.env, AUTH_MODE: "none", HOST: "127.0.0.1", BRAIN_PATH: path, DB_PATH: `${path}/.measure-ui.db`, AGENT_BACKEND: "pi",
  BRAIN_UI_PI_PROFILES: JSON.stringify([{ id: "measure", label: `Codex schema ${form}`, vendor: "openai-codex", model }]),
  BRAIN_UI_MODEL_DISCOVERY: "0", BRAIN_UI_PRICING_DISCOVERY: "0", BRAIN_UI_COASTLINE: "0", BRAIN_UI_TURN_TIMEOUT_MS: "180000",
});
const app = await createApp({ config, dbPath: `${path}/.measure-ui.db` });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket: app.websocket });
try {
  const record = await runOnce(`ws://127.0.0.1:${server.port}/ws`, "measure", path, "show_block", 0, 0, PI_SCHEMA_PROMPT);
  await waitPiSchemaCaptures(); // retain late metadata and natural upstream EOF before admission
  const versions = observedRuntimeVersions(app.db, record.result?.sessionId);
  const receiptsPath = resolve(process.env.BRAIN_MEASURE_PI_RECEIPTS!, "physical-requests.json");
  const physicalReceipts = existsSync(receiptsPath) ? JSON.parse(readFileSync(receiptsPath,"utf8")) : [];
  const recoveredOriginalPhysicalRequests=physicalReceipts.filter((receipt:any)=>receipt.provenance?.kind==="recovered-original-physical").length;
  const replay=recoveredOriginalPhysicalRequests?{method:"replay-prefix-continuation",originalServerTurnRemainsFailed:true,sameServerSession:false,unchangedRequestWire:false,recoveredOriginalPhysicalRequests,newExternalRequestAttempts:physicalReceipts.length-recoveredOriginalPhysicalRequests,physicalCountsAndUsageIncludeOriginalOnce:true}:null;
  const evidence = { replay, provider: "openai-codex", model, form, prompt: PI_SCHEMA_PROMPT, repetitions: 1, versions, physicalReceipts, billing: { route: "included-subscription-only; protected native OAuth, no API fallback", additionalBilledUsd: null, invoiceKnown: false }, record };
  await Bun.write(out, JSON.stringify(evidence, null, 2));
  assertPiSchemaAcceptance(record, physicalReceipts, form);
} finally { server.stop(true); await app.close(); }
