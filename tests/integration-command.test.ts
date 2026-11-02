import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { GitReservationStore, emptyReservation, reservationTransition, MAX_MS } from "../scripts/integration-reservation";
import { declareFix, emptyRedMain, openRed } from "../scripts/red-main";
import { receiptBlock, type CheckReceipt } from "../scripts/check-receipt";
import { invocationChild } from "../scripts/test-invocation-child";
import { processIdentity } from "../scripts/workspace-lease.mjs";

const dirs: string[] = [];
type ScenarioResult = { code: number; out: string; err: string; dispatched: boolean; reads: string[]; state: ReturnType<GitReservationStore["read"]>["state"];
  redMain: ReturnType<GitReservationStore["read"]>["redMain"]; events: any[] };
type Scenario = { dir?: string; child?: ReturnType<typeof invocationChild>; work?: Promise<ScenarioResult>; settled: boolean; beforeRead?: () => Promise<void> };
const scenarios = new Set<Scenario>();
let deadline: ReturnType<typeof setTimeout>, overdue = false, deadlineCleanup: Promise<void> | undefined;
beforeEach(() => {
  overdue = false; deadlineCleanup = undefined;
  // Bun kills dangling children before afterEach on timeout. Reserve three
  // seconds inside its unchanged 30-second cap for the owned group/output join.
  deadline = setTimeout(() => {
    overdue = true;
    deadlineCleanup = stopScenarios();
    void deadlineCleanup.catch(() => {}); // afterEach observes cleanup errors.
  }, 27_000);
});
async function stopScenarios() {
  const active = [...scenarios];
  const stopped = await Promise.allSettled(active.map(owner => owner.child?.stop("SIGTERM")));
  // A timed-out Bun test can still resume after its child exits. Join the
  // entire scenario, including its final Git read, before removing its cwd.
  await Promise.allSettled(active.map(owner => owner.work));
  const errors = stopped.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "Integration fixture cleanup failed");
}
afterEach(async () => {
  clearTimeout(deadline);
  await deadlineCleanup;
  await stopScenarios();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const NOW = Date.parse("2026-07-12T00:00:00Z");
function startScenario(mode: string, beforeRead?: () => Promise<void>) {
  const owner: Scenario = { settled: false, beforeRead };
  scenarios.add(owner);
  const work = runScenario(mode, owner);
  owner.work = work;
  const settled = () => { owner.settled = true; scenarios.delete(owner); };
  void work.then(settled, settled);
  return { owner, work };
}
function scenario(mode: string) { return startScenario(mode).work; }
async function runScenario(mode: string, owner: Scenario): Promise<ScenarioResult> {
  if (overdue) throw new Error("Integration fixture work deadline exceeded; owned cleanup joined inside the 30-second test cap");
  const dir = mkdtempSync(join(tmpdir(), "odysseus-integration-command-")); dirs.push(dir);
  owner.dir = dir;
  const root = join(dir, "client"), remote = join(dir, "remote.git"), bin = join(dir, "bin");
  mkdirSync(root); mkdirSync(bin);
  const realGit = Bun.which("git")!;
  const setup = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync([realGit, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env,
      GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@example.invalid", GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@example.invalid" } });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0); return new TextDecoder().decode(result.stdout).trim();
  };
  setup(dir, "init", "--bare", remote); setup(root, "init"); setup(root, "remote", "add", "origin", remote);
  writeFileSync(join(root, "README.md"), "Odysseus sails.\n"); mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests/raft.test.ts"), "// The raft breaks.\n"); setup(root, "add", ".");
  // Proof-system lane modes (#3269, #3271): main is ithaca, a proof-system squash
  // (sails), one product squash (oars), then base. Unless "-product", the
  // candidate first changes the proof system (shards), then adds raft.md.
  const lane = mode.includes("lane-"), history: Record<string, string> = {};
  const commitAll = (name: string, parents: string[]) => { setup(root, "add", "."); return setup(root, "commit-tree", setup(root, "write-tree"), ...parents.flatMap(parent => ["-p", parent]), "-m", name); };
  if (lane) {
    history.ithaca = commitAll("ithaca", []);
    mkdirSync(join(root, ".github/workflows"), { recursive: true }); writeFileSync(join(root, ".github/workflows/ci.yml"), "name: ci\n");
    history.sails = commitAll("sails", [history.ithaca]);
    writeFileSync(join(root, "oars.md"), "Oars.\n"); history.oars = commitAll("oars", [history.sails]);
  }
  const base = commitAll("base", lane ? [history.oars!] : []);
  setup(root, "update-ref", "HEAD", base);
  let headParent = base;
  if (lane && !mode.includes("-product")) {
    mkdirSync(join(root, "scripts")); writeFileSync(join(root, "scripts/ci-shards.ts"), "export const shards = 3;\n");
    headParent = history.shards = commitAll("shards", [base]);
  }
  writeFileSync(join(root, "raft.md"), "The crossing.\n"); setup(root, "add", ".");
  // A targeted revert deletes the failing test file its reverted commit added.
  if (mode === "expedite-revert") setup(root, "rm", "-q", "--cached", "tests/raft.test.ts");
  const tree = setup(root, "write-tree"), head = setup(root, "commit-tree", tree, "-p", headParent, "-m", "head");
  const synthetic = setup(root, "commit-tree", tree, "-p", base, "-p", head, "-m", "tested merge");
  const squash = setup(root, "commit-tree", tree, "-p", base, "-m", "actual squash");
  setup(root, "push", "origin", `${base}:refs/heads/main`, `${synthetic}:refs/heads/proof-fixture`, `${squash}:refs/heads/squash-fixture`);
  const candidate = { repository: "https://github.com/odysseus/brain-kit", pr: 7, head, base };
  const id = "1".repeat(32), store = new GitReservationStore(root), snapshot = store.read();
  const state = mode === "missing" || mode.startsWith("confirm-") ? emptyReservation() : reservationTransition(emptyReservation(), { kind: "acquire", candidate, id }, mode === "wrong-owner" ? 202 : 101, mode === "expired" ? NOW - 300_000 : NOW);
  expect(store.publish(snapshot, state)).toBe(true);
  if (mode.startsWith("red-main") || mode.startsWith("expedite-")) {
    const failure = { test: mode === "expedite-category" ? null : "tests/raft.test.ts", category: mode === "expedite-category" ? "browser" as const : "unit" as const,
      verdict: "real" as const, reasons: ["in-affected-closure"], run: 11, sha: base };
    const red = openRed(emptyRedMain(), { firstBad: base, run: 11, failures: [failure] }, NOW);
    expect(store.publishRedMain(store.read(), mode.startsWith("red-main-fix") ? declareFix(red, 7, NOW) : red)).toBe(true);
  }
  const sentinel = join(dir, "merged"), apiState = join(dir, "api.json");
  writeFileSync(apiState, JSON.stringify({ mode, revoked: false, merged: false, now: NOW, requested: false, draft: false }));
  const count = mode.startsWith("issues-") ? Number(mode.split("-")[1]) : 1;
  const refs = Array.from({ length: count }, (_, index) => `odysseus/brain-kit#${index + 9}`);
  const delivered = mode.endsWith("-missing") ? refs.slice(0, -1) : mode.endsWith("-malformed") ? [...refs.slice(0, -1), "bad"] : refs;
  const library = resolve(import.meta.dir, "../scripts/integration-reservation.ts");
  const shim = join(bin, "git");
  // Sixty real remote-CAS renewals must fit the unchanged deadline. Only the
  // origin display is synthetic; exec Git directly for every actual operation.
  writeFileSync(shim, `#!/bin/sh
if [ "$#" -eq 3 ] && [ "$1" = remote ] && [ "$2" = get-url ] && [ "$3" = origin ]; then
  printf '%s\\n' 'https://github.com/odysseus/brain-kit.git'
else
  exec '${realGit.replaceAll("'", "'\\''")}' "$@"
fi`); chmodSync(shim, 0o755);
  const gh = join(bin, "gh"), actual = { sha: synthetic, tree, parents: [base, head] };
  const check = (name: string, categories: CheckReceipt["checks"][number]["categories"], outcome: CheckReceipt["checks"][number]["outcome"] = "passed") => ({ name, categories, outcome });
  const receipt: CheckReceipt = { version: 1, kind: "brain-check-pr-receipt", head, base: "origin/main", mode: "focused", startedAt: "2026-07-12T00:00:00.000Z",
    finishedAt: "2026-07-12T00:05:00.000Z", checks: [check("all lint and leakage gates", ["changeset"]), check("affected fast invariants", ["verify", "unit"]),
      ...(mode === "receipt-uncovered" ? [check("complete pinned visual/accessibility/pointer suite", ["browser"], "timed-out"), check("complete unit and integration suite", ["unit"], "preempted")] : []),
      ...(mode === "browser-receipt-skipped" ? [check("complete pinned visual/accessibility/pointer suite", ["browser"], "skipped")] : [])] };
  const qualification = lane && !mode.includes("unqualified") && !mode.startsWith("expedite-") ? `## Off-main qualification\n\nReplay https://github.com/odysseus/brain-kit/actions/runs/555 compares three shards with two.\n\n` : "";
  const body = mode === "receipt-absent" || mode.startsWith("expedite-") ? "Odysseus builds a raft.\n" : `Odysseus builds a raft.\n\n${qualification}${receiptBlock(receipt)}\n`;
  const qualificationRuns = { 555: mode.includes("stale-run") ? base : mode.includes("ancestor-run") ? history.shards : head };
  // Main-push CI runs at the window squashes: sails and oars green; base green only once the lane is open.
  const window = (id: number, conclusion: string | null) => ({ id, status: conclusion ? "completed" : "in_progress", conclusion });
  const mainRuns: Record<string, ReturnType<typeof window>> = !lane ? {} : { [history.sails!]: window(81, "success"), [history.oars!]: window(82, "success"),
    ...(mode.includes("lane-short") ? {} : { [base]: window(83, mode.includes("cancelled") ? "cancelled" : "success") }) };
  const probeLog = (id: number) => (id === 401 ? { sha: base, tests: ["tests/raft.test.ts"], absent: [], exitCode: mode === "expedite-base-green" ? 0 : 1 }
    : mode === "expedite-revert" ? { sha: head, tests: [], absent: ["tests/raft.test.ts"], exitCode: 0 }
    : { sha: head, tests: ["tests/raft.test.ts"], absent: [], exitCode: mode === "expedite-head-red" ? 1 : 0 });
  writeFileSync(gh, `#!${process.execPath}
    import {readFileSync,writeFileSync} from "node:fs";
    import {GitReservationStore,reservationTransition} from ${JSON.stringify(library)};
    const args=process.argv.slice(2), file=${JSON.stringify(apiState)}, s=JSON.parse(readFileSync(file,"utf8"));
    const candidate=${JSON.stringify(candidate)}, actual=${JSON.stringify(actual)}, root=${JSON.stringify(root)}, remote=${JSON.stringify(remote)};
    const refs=${JSON.stringify(refs)}, body=${JSON.stringify(body)}, probes=${JSON.stringify({ 401: probeLog(401), 402: probeLog(402) })};s.reads??=[];
    const mainRuns=${JSON.stringify(mainRuns)}, qualificationRuns=${JSON.stringify(qualificationRuns)};
    const repo="odysseus/brain-kit", base=candidate.base, head=candidate.head, squash=${JSON.stringify(squash)};
    const categories=["verify","pack","unit","browser","layout","captures","runtime","runtime_host","endurance"];
    const selected={selections:Object.fromEntries(categories.map(x=>[x,"false"])),results:Object.fromEntries(categories.map(x=>[x,"skipped"])),retained:[],unitShards:null};
    if(s.mode.startsWith("browser-")){selected.selections.browser="true";selected.results.browser="success";}
    if(s.mode==="receipt-uncovered"){selected.selections.unit="false";}
    if(s.mode==="missing-selection")delete selected.selections.endurance;
    if(s.mode==="unexpected-skip"){selected.selections.endurance="true";selected.results.endurance="success";}
    const job=(id,name,conclusion="success")=>({id,name,status:"completed",conclusion,run_id:91,head_sha:head});
    const jobs=[job(1,"changeset"),job(2,"proof"),...categories.flatMap((name,index)=>name==="browser"&&s.mode.startsWith("browser-")
      ?[1,2,3].filter(shard=>s.mode!=="browser-missing-third"||shard!==3).map(shard=>job(20+shard,"browser ("+shard+")"))
      :[job(index+3,name,"skipped")])];
    const run=(id,workflow)=>({id,run_attempt:1,event:"pull_request",head_sha:head,status:s.mode.startsWith("confirm-")&&workflow==="ci"&&s.requested&&(s.mode==="confirm-cap"||s.now===${NOW})?"queued":"completed",conclusion:s.mode==="proof-failure"&&workflow==="ci"?"failure":s.mode==="confirm-cancel"&&s.requested&&workflow==="ci"?"cancelled":"success",repository:{html_url:candidate.repository},head_repository:{html_url:candidate.repository},pull_requests:[{number:7}]});
    const checkout="[command]git log -1 --format=%H\\n2026-07-12T00:00:00Z "+(s.mode==="wrong-checkout"?"c".repeat(40):actual.sha)+"\\n";
    let value;
    if(args[0]==="repo")value=repo;
    else if(args[0]==="pr"&&args[1]==="view")value={closingIssuesReferences:refs.map(ref=>({url:"https://github.com/"+ref.replace("#","/issues/")}))};
    else if(args[0]==="pr"&&args[1]==="ready"){s.draft=args.includes("--undo");if(!s.draft)s.requested=true;value="ready";}
    else if(args[0]==="pr"&&args[1]==="merge") {writeFileSync(${JSON.stringify(sentinel)},"merged");s.merged=true;const result=Bun.spawnSync([${JSON.stringify(realGit)},"--git-dir",remote,"update-ref","refs/heads/main",squash]);if(result.exitCode)throw new Error("Fixture main update failed");value="merged";}
    else if(args[0]==="api") {
      const path=args.find(x=>x.startsWith("repos/"))??args[1];
      if(s.mode==="confirm-held"&&s.requested&&path.includes("actions/workflows/ci.yml/runs")){
        writeFileSync(${JSON.stringify(join(dir, "held"))},JSON.stringify({pid:process.pid,start:readFileSync("/proc/self/stat","utf8").split(") ").at(-1).split(" ")[19]}));
        await new Promise(()=>setInterval(()=>{},1000));
      }
      if(args.includes("--include")){console.log("HTTP/2.0 200 OK\\nDate: "+new Date(s.now).toUTCString()+"\\n\\n{}");writeFileSync(file,JSON.stringify(s));process.exit(0);}
      if(path==="user")value={id:101,login:"odysseus"};
      else if(path.includes("actions/workflows/red-main-probe.yml/runs"))value={workflow_runs:[[301,base,probes[401]],[302,head,probes[402]]].map(([id,sha,p])=>({id,run_attempt:1,status:"completed",conclusion:p.exitCode?"failure":"success",display_title:"red-main probe fix 11 "+sha}))};
      else if(["/runs/301/attempts/1/jobs","/runs/302/attempts/1/jobs"].some(x=>path.includes(x)))value={jobs:[{id:path.includes("/301/")?401:402,name:"probe",status:"completed"}]};
      else if(path.endsWith("actions/jobs/401/logs")||path.endsWith("actions/jobs/402/logs"))value="2026-07-12T00:00:00Z BRAIN_RED_MAIN_PROBE "+JSON.stringify({purpose:"fix",...probes[path.includes("/401/")?401:402]});
      else if(path.endsWith("/pulls/7"))value={number:7,state:s.merged?"closed":"open",draft:s.draft,merged:s.merged,merge_commit_sha:squash,head:{sha:s.mode==="changed-head"?"e".repeat(40):head,repo:{full_name:repo}},base:{ref:"main",sha:base,repo:{full_name:repo}},milestone:{title:"0.44.0"},body};
      else if(path.endsWith("git/ref/heads/main"))value={object:{sha:s.mode==="changed-base"?"d".repeat(40):base}};
      else if(path.includes("actions/workflows/ci.yml/runs?event=push"))value={workflow_runs:Object.entries(mainRuns).filter(([sha])=>path.includes("head_sha="+sha)).map(([sha,run])=>({...run,head_sha:sha}))};
      else if(/actions\\/runs\\/555$/.test(path))value={id:555,head_sha:qualificationRuns[555],repository:{full_name:repo}};
      else if(path.includes("actions/workflows/ci.yml/runs"))value={workflow_runs:[run(s.mode.startsWith("confirm-")&&!s.requested?90:91,"ci")]};
      else if(path.includes("actions/workflows/contract.yml/runs"))value={workflow_runs:[run(92,"contract")]};
      else if(path.includes("/attempts/1/jobs"))value={total_count:jobs.length,jobs};
      else if(path.endsWith("actions/jobs/1/logs"))value=checkout+'"cadence": "confirmation"';
      else if(path.endsWith("actions/jobs/2/logs")) {
        if(s.mode==="revoked-during-proof"&&!s.revoked){const store=new GitReservationStore(root), snap=store.read();store.publish(snap,reservationTransition(snap.state,{kind:"revoke",maintainer:true,reason:"Abandon controlled fixture"},202,s.now));s.revoked=true;}
        value=checkout+"BRAIN_CANDIDATE_RECEIPT "+JSON.stringify({event:"ready_for_review",head,base,checkout:actual})+"\\nBRAIN_SELECTED_PROOF_RECEIPT "+JSON.stringify(selected)+"\\nAll selected hosted proof passed; remaining skips are planner-intended.";}
      else if(/actions\\/jobs\\/2[123]\\/logs$/.test(path))value=checkout;
      else if(path.endsWith("git/commits/"+actual.sha))value={sha:actual.sha,tree:{sha:actual.tree},parents:actual.parents.map(sha=>({sha}))};
      else if(path.endsWith("git/commits/"+squash))value={sha:squash,tree:{sha:actual.tree},parents:[{sha:base}]};
      else if(/issues\\/\\d+$/.test(path)){s.reads.push(path);value={milestone:{title:s.mode==="wrong-milestone"||(s.mode.endsWith("-mismatch")&&path.endsWith("issues/30"))?"0.43.1":"0.44.0"}};}
      else throw new Error("Unexpected offline API "+path);
    } else throw new Error("Unexpected offline gh "+JSON.stringify(args));
    writeFileSync(file,JSON.stringify(s));console.log(typeof value==="string"?value:JSON.stringify(value));`); chmodSync(gh, 0o755);
  const preload = join(dir, "clock.ts");
  writeFileSync(preload, `import {readFileSync,writeFileSync} from "node:fs";const callbacks=new Map();let id=0;
    const originalSet=globalThis.setInterval,originalClear=globalThis.clearInterval,originalSleep=Bun.sleep;
    globalThis.setInterval=(callback,ms,...args)=>ms===60000?(callbacks.set(++id,callback),id):originalSet(callback,ms,...args);
    globalThis.clearInterval=timer=>callbacks.has(timer)?callbacks.delete(timer):originalClear(timer);
    Bun.sleep=async ms=>{if(ms!==60000)return originalSleep(ms);const file=${JSON.stringify(apiState)},state=JSON.parse(readFileSync(file,"utf8"));state.now+=ms;writeFileSync(file,JSON.stringify(state));for(const callback of callbacks.values())await callback();};`);
  const command = mode.endsWith("-read") ? ["lane", "--json"] : [mode.startsWith("confirm-") ? "confirm" : "merge", "7", ...(mode.startsWith("confirm-") ? [] : ["--lease", mode === "wrong-id" ? "2".repeat(32) : id]), "--issues", delivered.join(","),
    ...(mode.startsWith("expedite-") ? ["--fixes-main-run", "11"] : [])];
  const child = invocationChild([process.execPath, ...(mode.startsWith("confirm-") ? ["--preload", preload] : []), resolve(import.meta.dir, "../scripts/integrate.ts"), ...command], {
    cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  owner.child = child;
  const output = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  try {
    await child.ready;
    const [code, out, err] = await output;
    await child.finish();
    if (overdue) throw new Error("Integration fixture work deadline exceeded; owned cleanup joined inside the 30-second test cap");
    await owner.beforeRead?.();
    const eventDir = join(root, "tmp/ci-timings");
    const events = existsSync(eventDir) ? readdirSync(eventDir).filter(name => name.startsWith("event-")).map(name => JSON.parse(readFileSync(join(eventDir, name), "utf8"))) : [];
    return { code, out, err, dispatched: existsSync(sentinel), reads: JSON.parse(readFileSync(apiState, "utf8")).reads ?? [], state: store.read().state, redMain: store.read().redMain, events };
  } finally {
    await child.stop("SIGTERM");
    await Promise.allSettled([output]);
    await child.finish();
  }
}

test("shared merge executable rejects missing, stale, wrong-owner and changed-candidate authority before merge", async () => {
  for (const mode of ["missing", "wrong-id", "wrong-owner", "expired", "changed-base", "proof-failure", "wrong-checkout", "wrong-milestone", "revoked-during-proof", "changed-head", "missing-selection", "unexpected-skip"]) {
    const result = await scenario(mode);
    expect(result.dispatched, `NO_MERGE_WITH_INVALID_AUTHORITY:${mode}`).toBe(false);
    expect(result.code, result.err).toBe(1);
    const expected = mode === "changed-base" ? "ordinary exact-main candidate" : mode === "proof-failure" ? "Complete current-candidate CI and contract proof required"
      : mode === "changed-head" ? "mismatched candidate reservation" : mode === "missing-selection" ? "aggregate policy" : mode === "unexpected-skip" ? "Actual selected job inventory differs" : mode === "wrong-checkout" ? "Selected job ran a different checkout" : mode === "wrong-milestone" ? "Release milestone mismatch" : "Missing, expired, superseded";
    expect(result.err).toContain(expected);
  }
});

test("shared merge executable preserves actual proof and squash identities and releases after delivery", async () => {
  const result = await scenario("valid");
  expect(result.code, result.err).toBe(2); expect(result.dispatched).toBe(true);
  expect(result.out).toContain('"merged":true'); expect(result.out).toContain("pending; inspect actual main jobs");
  expect(result.state.active).toBeNull(); expect(result.state.last?.action).toBe("release");
});

test("confirmation executable renews automatically, releases cancellation and cannot renew beyond the cap", async () => {
  for (const mode of ["confirm-cancel", "confirm-cap", "confirm-valid"]) {
    const result = await scenario(mode);
    expect(result.state.active, result.err).toBeNull();
    expect(result.dispatched).toBe(mode === "confirm-valid");
    expect(result.code, result.err).toBe(mode === "confirm-valid" ? 2 : 1);
    if (mode === "confirm-cancel") expect(result.err).toContain("Candidate proof cancelled");
    if (mode === "confirm-cap") {
      expect(result.state.last?.at).toBe(NOW + MAX_MS);
      expect(result.state.last?.previous?.cap).toBe(NOW + MAX_MS);
      expect(result.err).toContain("expired");
    }
  }
});

test("scenario teardown stops the executable and its helper, drains output and joins the final Git read", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const { owner, work } = startScenario("confirm-held", async () => { entered.resolve(); await release.promise; });
  try {
    const marker = join(owner.dir!, "held"), deadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(marker), "REAL_CONFIRMATION_HELPER_REACHED_OWNED_HOLD").toBe(true);
    const helper = JSON.parse(readFileSync(marker, "utf8")) as { pid: number; start: string };
    expect(processIdentity(helper.pid)?.start).toBe(helper.start);
    let cleaned = false;
    const cleanup = stopScenarios().then(() => { cleaned = true; });
    await entered.promise;
    // Join the same native stop before observing the still-held continuation.
    await owner.child!.stop("SIGTERM");
    expect(cleaned, "TEARDOWN_MUST_JOIN_LATE_SCENARIO_BEFORE_REMOVING_CWD").toBe(false);
    expect(existsSync(owner.dir!)).toBe(true);
    release.resolve(); await cleanup;
    expect(owner.settled, "TEARDOWN_JOINS_FINAL_GIT_READ").toBe(true);
    const result = await work;
    expect(result.code).not.toBe(0);
    expect(result.out, "CANCELLATION_DRAINS_EXECUTABLE_OUTPUT").toContain('"acquired":');
    expect(processIdentity(helper.pid)?.start, "TEARDOWN_STOPS_OWNED_HELPER").not.toBe(helper.start);
    expect(processIdentity(owner.child!.pid), "TEARDOWN_STOPS_OWNED_EXECUTABLE").toBeUndefined();
  } finally { release.resolve(); await stopScenarios(); }
});

// The delivered workflow has three browser jobs. Keep this independent fixture
// literal so a stale two-job verifier cannot bless incomplete selected proof.
test("shared merge executable requires all three delivered browser shards", async () => {
  const complete = await scenario("browser-complete");
  expect(complete.code, `COMPLETE_SELECTED_BROWSER_INVENTORY: ${complete.err}`).toBe(2);
  expect(complete.dispatched).toBe(true);
  const missing = await scenario("browser-missing-third");
  expect(missing.dispatched, "NO_MERGE_WITH_MISSING_THIRD_BROWSER_SHARD").toBe(false);
  expect(missing.code).toBe(1);
  expect(missing.err).toContain("Actual selected job inventory differs");
});

test("delivered issues accepts 22 and the finite boundary with every milestone read back", async () => {
  for (const count of [22, 100]) {
    const result = await scenario(`issues-${count}`);
    expect(result.code, `ALL_DELIVERED_ISSUES_VALIDATED:${count}: ${result.err}`).toBe(2);
    expect(result.dispatched).toBe(true);
    const expected = Array.from({ length: count }, (_, index) => `repos/odysseus/brain-kit/issues/${index + 9}`);
    expect(result.reads).toEqual([...expected, ...expected]);
    expect(result.state.active).toBeNull();
  }
});

test("delivered issues refuses malformed oversized missing closing and final milestone mismatch", async () => {
  for (const [mode, message] of [
    ["issues-22-malformed", "Invalid delivered issue identities"],
    ["issues-101", "Invalid delivered issue identities"],
    ["issues-22-missing", "must include every closing issue"],
    ["issues-22-mismatch", "Release milestone mismatch: odysseus/brain-kit#30"],
  ] as const) {
    const result = await scenario(mode);
    expect(result.code, result.err).toBe(1);
    expect(result.err).toContain(message);
    expect(result.dispatched).toBe(false);
    if (mode === "issues-22-mismatch") expect(result.reads).toHaveLength(22);
    if (mode === "issues-22-missing") expect(result.reads).toEqual([]);
  }
});

test("while main is red the shared merge refuses non-fix candidates and still merges a declared fix (#2942)", async () => {
  const refused = await scenario("red-main");
  expect(refused.dispatched, "NO_NON_FIX_MERGE_WHILE_RED").toBe(false);
  expect(refused.code, refused.err).toBe(1);
  expect(refused.err).toContain("main red at");
  expect(refused.err).toContain("only a declared fix may confirm or merge");
  const fix = await scenario("red-main-fix");
  expect(fix.code, `DECLARED_FIX_MERGES: ${fix.err}`).toBe(2);
  expect(fix.dispatched).toBe(true);
});

test("the merge path refuses uncovered local skips and a missing receipt, and accepts covered ones (#2940)", async () => {
  const uncovered = await scenario("receipt-uncovered");
  expect(uncovered.dispatched, "NO_MERGE_WITH_UNCOVERED_LOCAL_SKIPS").toBe(false);
  expect(uncovered.code, uncovered.err).toBe(1);
  expect(uncovered.err).toContain("complete pinned visual/accessibility/pointer suite (timed-out; needs browser)");
  expect(uncovered.err).toContain("complete unit and integration suite (preempted; needs unit)");
  expect(uncovered.state.active, "REFUSAL_RELEASES_THE_LEASE").toBeNull();
  const missing = await scenario("receipt-absent");
  expect(missing.dispatched).toBe(false);
  expect(missing.err).toContain("No check:pr receipt in the PR body");
  const covered = await scenario("browser-receipt-skipped");
  expect(covered.code, `SKIP_COVERED_BY_EXACT_HEAD_HOSTED_BROWSER: ${covered.err}`).toBe(2);
  expect(covered.dispatched).toBe(true);
});

test("expedited fix merges only with red-on-base and green-on-head evidence, and records it (#2940)", async () => {
  for (const [mode, message] of [
    ["expedite-base-green", "not shown red on the bad base"],
    ["expedite-head-red", "not shown green on the fix head"],
    ["expedite-category", "Category-level red failures (browser)"],
  ] as const) {
    const refused = await scenario(mode);
    expect(refused.dispatched, `NO_EXPEDITED_MERGE:${mode}`).toBe(false);
    expect(refused.code, refused.err).toBe(1);
    expect(refused.err).toContain(message);
  }
  for (const mode of ["expedite-valid", "expedite-revert"]) {
    const fix = await scenario(mode);
    expect(fix.code, `EXPEDITED_FIX_MERGES:${mode}: ${fix.err}`).toBe(2);
    expect(fix.dispatched).toBe(true);
    expect(fix.out).toContain('"expedited":{"fixesMainRun":11,"baseProbe":301,"headProbe":302');
    expect(fix.state.active).toBeNull(); expect(fix.state.last?.action).toBe("release");
    // The record stays open: only the next green main run that includes the red set clears it.
    expect(fix.redMain.open?.fixes).toEqual([7]);
    expect(fix.redMain.open?.expedited).toMatchObject([{ pr: 7, baseProbe: 301, headProbe: 302, feedbackRun: 91, actor: 101 }]);
    expect(fix.events).toMatchObject([{ kind: "expedited-fix", pr: 7, run: 11, repository: "odysseus/brain-kit", evidence: "https://github.com/odysseus/brain-kit/actions/runs/302" }]);
  }
});

test("a proof-system candidate waits for the two-green-main stability window; a product candidate does not (#3269)", async () => {
  for (const mode of ["lane-short", "lane-cancelled", "confirm-lane-short"]) {
    const refused = await scenario(mode);
    expect(refused.dispatched, `NO_PROOF_SYSTEM_MERGE_INSIDE_THE_WINDOW:${mode}`).toBe(false);
    expect(refused.code, refused.err).toBe(1);
    expect(refused.err).toContain("Proof-system candidate refused (scripts/ci-shards.ts)");
    expect(refused.err).toContain("1 more green main run required");
    expect(refused.err).not.toContain("Off-main qualification missing");
    expect(refused.state.active, `REFUSED_BEFORE_OWNERSHIP_OR_RELEASED:${mode}`).toBeNull();
  }
  for (const mode of ["lane-short-product", "lane-open"]) {
    const accepted = await scenario(mode);
    expect(accepted.code, `LANE_ACCEPTS:${mode}: ${accepted.err}`).toBe(2);
    expect(accepted.dispatched).toBe(true);
  }
});

test("lane --json reports the refusal's decision from the same function (#3269)", async () => {
  const read = await scenario("lane-short-read");
  expect(read.code, read.err).toBe(0);
  const decision = JSON.parse(read.out);
  expect(decision).toMatchObject({ schemaVersion: 1, open: false, missing: 1, window: [{ position: 0, green: true, run: { id: 81 } }, { position: 1, green: true, run: { id: 82 } }, { position: 2, green: false, run: null }] });
  expect(decision.refusal).toContain("1 more green main run required");
  expect(decision.refusal).toContain(`the last proof-system squash ${decision.proofSystemSquash}`);
  const open = await scenario("lane-open-read");
  expect(JSON.parse(open.out), open.err).toMatchObject({ open: true, missing: 0, refusal: null });
});

test("a proof-system candidate needs off-main qualification on its head or a proof-system-free ancestor (#3271)", async () => {
  for (const [mode, message] of [
    ["lane-open-unqualified", 'no "Off-main qualification" section'],
    ["lane-open-stale-run", "the diff from there to the head is a proof-system change (scripts/ci-shards.ts)"],
  ] as const) {
    const refused = await scenario(mode);
    expect(refused.dispatched, `NO_UNQUALIFIED_PROOF_SYSTEM_MERGE:${mode}`).toBe(false);
    expect(refused.code, refused.err).toBe(1);
    expect(refused.err).toContain("Off-main qualification missing");
    expect(refused.err).toContain(message);
  }
  const ancestor = await scenario("lane-open-ancestor-run");
  expect(ancestor.code, `QUALIFIED_BY_A_PROOF_SYSTEM_FREE_ANCESTOR: ${ancestor.err}`).toBe(2);
  expect(ancestor.dispatched).toBe(true);
});

test("declared red-main fixes are exempt from the stability window and off-main qualification (#3269, #3271)", async () => {
  for (const mode of ["expedite-lane-short", "red-main-fix-lane-short"]) {
    const fix = await scenario(mode);
    expect(fix.code, `DECLARED_FIX_EXEMPT:${mode}: ${fix.err}`).toBe(2);
    expect(fix.dispatched).toBe(true);
  }
});
