import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { watchdogMs } from "../../../scripts/test-deadlines.js";
import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";

test("persistent alias failure refuses app boot with its cause; later admission refuses one turn and recovers", async () => {
  const root = mkdtempSync("/var/tmp/odysseus-app-alias-"), brain = join(root, "brain"), dbPath = join(root, "ui.db"), journal = `${dbPath}.journal`;
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  mkdirSync(journal); writeFileSync(join(journal, "object"), "private state");
  try {
    const program = `
      import * as fs from "node:fs";
      import {mock} from "bun:test";
      const original = fs.readdirSync;
      let broken = true, calls = 0;
      const ioFailure = Object.assign(Error("fixture journal scan unavailable"), {code:"EIO"});
      mock.module("node:fs",()=>({...fs,readdirSync(path,options){
        if(broken && fs.realpathSync(path)===${JSON.stringify(journal)}) throw ioFailure;
        return original(path,options);
      }}));
      const {createFixtureApp} = await import(${JSON.stringify(resolve(import.meta.dir, "helpers/native-app-fixture.ts"))});
      const {resolveServerConfig} = await import(${JSON.stringify(resolve(import.meta.dir, "../src/config/env.ts"))});
      const {createStaticBackendRegistry} = await import(${JSON.stringify(resolve(import.meta.dir, "../src/agent/backend.ts"))});
      const {makeFakeBackend} = await import(${JSON.stringify(resolve(import.meta.dir, "helpers/fake-backend.ts"))});
      const {createPrincipal} = await import(${JSON.stringify(resolve(import.meta.dir, "../src/db/principals.ts"))});
      const {testAuthorization} = await import(${JSON.stringify(resolve(import.meta.dir, "helpers/principal.ts"))});
      const {runSession} = await import(${JSON.stringify(resolve(import.meta.dir, "../src/ws/run-session.ts"))});
      const backend = makeFakeBackend({id:"offline",startTurn:async ({bridge})=>{calls++;bridge.emit({type:"session_info",sessionId:"sess-ithaca",isNew:true});bridge.emit({type:"result",sessionId:"sess-ithaca",durationMs:1,numTurns:1,isError:false});}});
      const options = {config:resolveServerConfig({BRAIN_PATH:${JSON.stringify(brain)},DB_PATH:${JSON.stringify(dbPath)},AUTH_MODE:"none",HOST:"127.0.0.1",NODE_ENV:"test",BRAIN_UI_MODEL_DISCOVERY:"0",BRAIN_UI_PRICING_DISCOVERY:"0"}),registry:createStaticBackendRegistry([backend],backend.id)};
      let bootError;
      try { const unexpected = await createFixtureApp(options); await unexpected.close(); }
      catch(error) { bootError = {name:error.name,message:error.message,reason:error.status?.reason,cause:error.cause?.message,sameCause:error.cause===ioFailure,causeInStatus:Object.keys(error.status??{}).includes("cause")}; }
      broken=false;
      const app = await createFixtureApp(options);
      broken=true;
      try {
        await app.fetch(new Request("http://localhost/api/status/worker-host", {method:"POST"}));
        const statusResponse=await app.fetch(new Request("http://localhost/api/status"));
        const status=await statusResponse.json();
        const principal=createPrincipal(app.db,{authMethod:"password",label:"Odysseus",ttlSeconds:60}),frames=[];
        app.wsHost.clients.add({send:text=>frames.push(JSON.parse(String(text)))},principal.id);
        await runSession(app.wsHost,{authorization:testAuthorization(principal.id),text:"Inspect Ithaca",attachments:[]});
        const refusedCalls=calls,refusal=frames.find(frame=>frame.type==="error");
        broken=false;
        await runSession(app.wsHost,{authorization:testAuthorization(principal.id),text:"Inspect Ithaca after verification",attachments:[]});
        console.log("READ_GATE_RECEIPT:"+JSON.stringify({bootError,statusCode:statusResponse.status,status:status.runtime?.workerHost?.governed,refusedCalls,refusal,calls}));
      } finally {await app.close();}
    `;
    const child = Bun.spawnSync([process.execPath, "--preload", resolve(import.meta.dir, "../../../scripts/test-network-child-preload.ts"), "-e", program], { env: { PATH: "/usr/bin:/bin" }, timeout: watchdogMs(30_000) });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const line = child.stdout.toString().split("\n").find(value => value.startsWith("READ_GATE_RECEIPT:"));
    expect(line, child.stdout.toString()).toBeDefined();
    const receipt = JSON.parse(line!.slice("READ_GATE_RECEIPT:".length));
    expect(receipt.bootError, "PERSISTENT_ALIAS_FAILURE_REFUSES_APP_BOOT_WITH_ORIGINAL_CAUSE").toMatchObject({
      name: "OperationalStateAliasVerificationUnavailable", reason: "private_state_unverified",
      message: expect.stringContaining("fixture journal scan unavailable"), cause: "fixture journal scan unavailable", sameCause: true, causeInStatus: false,
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.status).toMatchObject({ available: false, reason: "private_state_unverified" });
    expect(receipt.status.profile, "UNVERIFIED_STATUS_OFFERS_NO_STRICT_FALLBACK").toBeUndefined();
    expect(receipt.status.profileFallback, "STATUS_ADDS_NO_DIAGNOSTIC_BOOT_FALLBACK").toBeUndefined();
    expect(receipt.refusedCalls, "LATER_UNVERIFIED_ADMISSION_NEVER_ENTERS_BACKEND").toBe(0);
    expect(receipt.refusal, "APP_TURN_REPORTS_NAMED_PRIVATE_STATE_CAUSE").toMatchObject({ code: "PRIVATE_STATE_UNVERIFIED", failure: { errorClass: "private_state_unverified" } });
    expect(receipt.calls, "APP_ADMITS_NEXT_TURN_AFTER_AUTOMATIC_VERIFICATION").toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
