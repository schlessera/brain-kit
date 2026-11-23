import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { watchdogMs } from "../../../scripts/test-deadlines.js";

test("unverified private state keeps diagnostics available but refuses every maintenance entry until verification recovers", () => {
  const root = mkdtempSync("/var/tmp/odysseus-state-read-gate-"), brain = join(root, "brain"), state = join(root, "state");
  mkdirSync(brain); mkdirSync(state); writeFileSync(join(state, "object"), "private state");
  try {
    const program = `
      import * as fs from "node:fs";
      import { mock } from "bun:test";
      const original = fs.readdirSync;
      let broken = true;
      mock.module("node:fs", () => ({...fs, readdirSync(path, options) {
        if (broken && fs.realpathSync(path) === ${JSON.stringify(state)}) throw Object.assign(Error("fixture scan unavailable"), {code:"EIO"});
        return original(path, options);
      }}));
      const {createHostBoundary} = await import(${JSON.stringify(resolve(import.meta.dir, "../src/brain/host-boundary.ts"))});
      const {assertOperationalStateOutsideBrain} = await import(${JSON.stringify(resolve(import.meta.dir, "../src/brain/operational-state.ts"))});
      const layout = {brainPath:${JSON.stringify(brain)},privateStatePaths:[{setting:"journal",path:${JSON.stringify(state)}}]};
      assertOperationalStateOutsideBrain(layout);
      const boundary = createHostBoundary({...layout,workerHost:()=>({ok:false,requirement:"offline host fixture"})});
      const status = boundary.status(), refusals = [];
      const execution = {argv:["/bin/printf","RECOVERED"],env:{},credentials:false,gate:"none",purpose:"fixture",timeoutMs:30000};
      for (const method of ["run","launch","runSync"]) {
        try {
          const result = await boundary[method](execution);
          if (method === "launch") await Promise.all([new Response(result.stdout).text(),new Response(result.stderr).text(),result.exited]);
          refusals.push(null);
        } catch (error) { refusals.push({reason:error.reason,message:error.message}); }
      }
      const {readModuleList} = await import(${JSON.stringify(resolve(import.meta.dir, "../src/cron/module-discovery.ts"))});
      const modules = await readModuleList({}, boundary);
      const {withOperationalStateReadGuard} = await import(${JSON.stringify(resolve(import.meta.dir, "../src/brain/operational-state.ts"))});
      const rpc = [], nativeRefusals = [];
      const raw = Object.fromEntries(["checkpoint","prepareStage","prepareTurnTree","readCheckpoint","statCheckpoint","listCheckpoint","release","releaseStage","releaseTurnTree"].map(name => [name, async id => {rpc.push(name);return {id,state:"deleted"};}]));
      const manager = withOperationalStateReadGuard(raw, layout);
      for (const method of ["checkpoint","prepareStage","prepareTurnTree","readCheckpoint","statCheckpoint","listCheckpoint"]) {
        try { await manager[method](method); nativeRefusals.push(null); } catch (error) { nativeRefusals.push(error.reason); }
      }
      await manager.release("checkpoint"); await manager.releaseStage("prepareStage"); await manager.releaseTurnTree("prepareTurnTree");
      const refusedRpc = [...rpc];
      broken = false;
      await manager.checkpoint("recovered");
      const recovered = await boundary.run(execution);
      console.log(JSON.stringify({status,refusals,recovered,nativeRefusals,refusedRpc,rpc,modules}));`;
    const child = Bun.spawnSync([process.execPath, "--preload", resolve(import.meta.dir, "../../../scripts/test-network-child-preload.ts"), "-e", program], { env: { PATH: "/usr/bin:/bin" }, timeout: watchdogMs(30_000) });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const receipt = JSON.parse(child.stdout.toString());
    expect(receipt.status).toMatchObject({ available: false, reason: "private_state_unverified" });
    expect(receipt.status.profile, "UNVERIFIED_STATUS_OFFERS_NO_STRICT_FALLBACK").toBeUndefined();
    expect(receipt.refusals, "ALL_MAINTENANCE_ENTRIES_REFUSE_UNVERIFIED_BRAIN_READS").toEqual([0, 1, 2].map(() => expect.objectContaining({ reason: "private_state_unverified", message: expect.stringContaining("fixture scan unavailable") })));
    expect(receipt.modules, "MODULE_DISCOVERY_REFUSES_UNVERIFIED_STARTUP_INPUTS").toMatchObject({ modules: null, cause: expect.stringContaining("private_state_unverified"), retryable: true });
    expect(receipt.nativeRefusals, "EVERY_NATIVE_STARTUP_VIEW_READER_CHECKS_ISOLATION").toEqual(Array(6).fill("private_state_unverified"));
    expect(receipt.refusedRpc, "REFUSED_INPUTS_ACQUIRE_NO_ROOT_AND_RELEASE_NO_UNOWNED_ROOT").toEqual([]);
    expect(receipt.rpc, "NATIVE_INPUT_ACQUISITION_RECOVERS_AUTOMATICALLY").toEqual(["checkpoint"]);
    expect(receipt.recovered.stdout, "NEXT_VERIFIED_MAINTENANCE_IS_ADMITTED_AUTOMATICALLY").toBe("RECOVERED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

import { createFixtureBrain } from "../../../scripts/captures/core-fixture.js";

test("the app boots with status and settings while brain turns are refused, then admits after verification", async () => {
  const root = mkdtempSync("/var/tmp/odysseus-app-read-gate-"), brain = join(root, "brain"), dbPath = join(root, "ui.db"), journal = `${dbPath}.journal`;
  await createFixtureBrain(resolve(import.meta.dir, "../../.."), brain);
  mkdirSync(journal); writeFileSync(join(journal, "object"), "private state");
  try {
    const program = `
      import * as fs from "node:fs";
      import {mock} from "bun:test";
      const original = fs.readdirSync;
      let broken = true, calls = 0;
      mock.module("node:fs",()=>({...fs,readdirSync(path,options){
        if(broken && fs.realpathSync(path)===${JSON.stringify(journal)}) throw Object.assign(Error("fixture journal scan unavailable"),{code:"EIO"});
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
      const app = await createFixtureApp({config:resolveServerConfig({BRAIN_PATH:${JSON.stringify(brain)},DB_PATH:${JSON.stringify(dbPath)},AUTH_MODE:"none",HOST:"127.0.0.1",NODE_ENV:"test",BRAIN_UI_MODEL_DISCOVERY:"0",BRAIN_UI_PRICING_DISCOVERY:"0"}),registry:createStaticBackendRegistry([backend],backend.id)});
      try {
        const statusResponse=await app.fetch(new Request("http://localhost/api/status"));
        const status=await statusResponse.json();
        const settings=await app.fetch(new Request("http://localhost/api/settings/voice"));
        const principal=createPrincipal(app.db,{authMethod:"password",label:"Odysseus",ttlSeconds:60}),frames=[];
        app.wsHost.clients.add({send:text=>frames.push(JSON.parse(String(text)))},principal.id);
        await runSession(app.wsHost,{authorization:testAuthorization(principal.id),text:"Inspect Ithaca",attachments:[]});
        const refusedCalls=calls,refusal=frames.find(frame=>frame.type==="error");
        broken=false;
        await runSession(app.wsHost,{authorization:testAuthorization(principal.id),text:"Inspect Ithaca after verification",attachments:[]});
        console.log("READ_GATE_RECEIPT:"+JSON.stringify({statusCode:statusResponse.status,settingsCode:settings.status,status:status.runtime?.workerHost?.governed,refusedCalls,refusal,calls}));
      } finally {await app.close();}
    `;
    const child = Bun.spawnSync([process.execPath, "--preload", resolve(import.meta.dir, "../../../scripts/test-network-child-preload.ts"), "-e", program], { env: { PATH: "/usr/bin:/bin" }, timeout: watchdogMs(30_000) });
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const line = child.stdout.toString().split("\n").find(value => value.startsWith("READ_GATE_RECEIPT:"));
    expect(line, child.stdout.toString()).toBeDefined();
    const receipt = JSON.parse(line!.slice("READ_GATE_RECEIPT:".length));
    expect([receipt.statusCode, receipt.settingsCode], "RESTRICTED_BOOT_SERVES_STATUS_AND_SETTINGS").toEqual([200, 200]);
    expect(receipt.status).toMatchObject({ available: false, reason: "private_state_unverified" });
    expect(receipt.refusedCalls, "UNVERIFIED_APP_NEVER_ENTERS_BACKEND").toBe(0);
    expect(receipt.refusal, "APP_TURN_REPORTS_NAMED_PRIVATE_STATE_CAUSE").toMatchObject({ code: "PRIVATE_STATE_UNVERIFIED", failure: { errorClass: "private_state_unverified" } });
    expect(receipt.calls, "APP_ADMITS_NEXT_TURN_AFTER_AUTOMATIC_VERIFICATION").toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
