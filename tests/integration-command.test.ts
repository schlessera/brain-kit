import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { GitReservationStore, emptyReservation, reservationTransition, MAX_MS } from "../scripts/integration-reservation";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const NOW = Date.parse("2026-07-12T00:00:00Z");
async function scenario(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), "odysseus-integration-command-")); dirs.push(dir);
  const root = join(dir, "client"), remote = join(dir, "remote.git"), bin = join(dir, "bin");
  mkdirSync(root); mkdirSync(bin);
  const realGit = Bun.which("git")!;
  const setup = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync([realGit, ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env,
      GIT_AUTHOR_NAME: "Odysseus", GIT_AUTHOR_EMAIL: "odysseus@example.invalid", GIT_COMMITTER_NAME: "Odysseus", GIT_COMMITTER_EMAIL: "odysseus@example.invalid" } });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0); return new TextDecoder().decode(result.stdout).trim();
  };
  setup(dir, "init", "--bare", remote); setup(root, "init"); setup(root, "remote", "add", "origin", remote);
  writeFileSync(join(root, "README.md"), "Odysseus sails.\n"); setup(root, "add", ".");
  const base = setup(root, "commit-tree", setup(root, "write-tree"), "-m", "base");
  setup(root, "update-ref", "HEAD", base);
  writeFileSync(join(root, "raft.md"), "The crossing.\n"); setup(root, "add", ".");
  const tree = setup(root, "write-tree"), head = setup(root, "commit-tree", tree, "-p", base, "-m", "head");
  const synthetic = setup(root, "commit-tree", tree, "-p", base, "-p", head, "-m", "tested merge");
  const squash = setup(root, "commit-tree", tree, "-p", base, "-m", "actual squash");
  setup(root, "push", "origin", `${base}:refs/heads/main`, `${synthetic}:refs/heads/proof-fixture`, `${squash}:refs/heads/squash-fixture`);
  const candidate = { repository: "https://github.com/odysseus/brain-kit", pr: 7, head, base };
  const id = "1".repeat(32), store = new GitReservationStore(root), snapshot = store.read();
  const state = mode === "missing" || mode.startsWith("confirm-") ? emptyReservation() : reservationTransition(emptyReservation(), { kind: "acquire", candidate, id }, mode === "wrong-owner" ? 202 : 101, mode === "expired" ? NOW - 300_000 : NOW);
  expect(store.publish(snapshot, state)).toBe(true);
  const sentinel = join(dir, "merged"), apiState = join(dir, "api.json");
  writeFileSync(apiState, JSON.stringify({ mode, revoked: false, merged: false, now: NOW, requested: false, draft: false }));
  const library = resolve(import.meta.dir, "../scripts/integration-reservation.ts");
  const shim = join(bin, "git");
  writeFileSync(shim, `#!${process.execPath}
    const args=process.argv.slice(2);if(args.join(" ")==="remote get-url origin")console.log("https://github.com/odysseus/brain-kit.git");
    else {const result=Bun.spawnSync([${JSON.stringify(realGit)},...args],{stdin:"inherit",stdout:"inherit",stderr:"inherit"});process.exit(result.exitCode);}`); chmodSync(shim, 0o755);
  const gh = join(bin, "gh"), actual = { sha: synthetic, tree, parents: [base, head] };
  writeFileSync(gh, `#!${process.execPath}
    import {readFileSync,writeFileSync} from "node:fs";
    import {GitReservationStore,reservationTransition} from ${JSON.stringify(library)};
    const args=process.argv.slice(2), file=${JSON.stringify(apiState)}, s=JSON.parse(readFileSync(file,"utf8"));
    const candidate=${JSON.stringify(candidate)}, actual=${JSON.stringify(actual)}, root=${JSON.stringify(root)}, remote=${JSON.stringify(remote)};
    const repo="odysseus/brain-kit", base=candidate.base, head=candidate.head, squash=${JSON.stringify(squash)};
    const categories=["verify","pack","unit","browser","layout","captures","runtime","runtime_host","endurance"];
    const selected={selections:Object.fromEntries(categories.map(x=>[x,"false"])),results:Object.fromEntries(categories.map(x=>[x,"skipped"])),retained:[],unitShards:null};
    if(s.mode==="missing-selection")delete selected.selections.endurance;
    if(s.mode==="unexpected-skip"){selected.selections.endurance="true";selected.results.endurance="success";}
    const run=(id,workflow)=>({id,run_attempt:1,event:"pull_request",head_sha:head,status:s.mode.startsWith("confirm-")&&workflow==="ci"&&s.requested&&(s.mode==="confirm-cap"||s.now===${NOW})?"queued":"completed",conclusion:s.mode==="proof-failure"&&workflow==="ci"?"failure":s.mode==="confirm-cancel"&&s.requested&&workflow==="ci"?"cancelled":"success",repository:{html_url:candidate.repository},head_repository:{html_url:candidate.repository},pull_requests:[{number:7}]});
    const checkout="[command]git log -1 --format=%H\\n2026-07-12T00:00:00Z "+(s.mode==="wrong-checkout"?"c".repeat(40):actual.sha)+"\\n";
    let value;
    if(args[0]==="repo")value=repo;
    else if(args[0]==="pr"&&args[1]==="view")value={closingIssuesReferences:[{url:"https://github.com/odysseus/brain-kit/issues/9"}]};
    else if(args[0]==="pr"&&args[1]==="ready"){s.draft=args.includes("--undo");if(!s.draft)s.requested=true;value="ready";}
    else if(args[0]==="pr"&&args[1]==="merge") {writeFileSync(${JSON.stringify(sentinel)},"merged");s.merged=true;const result=Bun.spawnSync([${JSON.stringify(realGit)},"--git-dir",remote,"update-ref","refs/heads/main",squash]);if(result.exitCode)throw new Error("Fixture main update failed");value="merged";}
    else if(args[0]==="api") {
      const path=args.find(x=>x.startsWith("repos/"))??args[1];
      if(args.includes("--include")){console.log("HTTP/2.0 200 OK\\nDate: "+new Date(s.now).toUTCString()+"\\n\\n{}");writeFileSync(file,JSON.stringify(s));process.exit(0);}
      if(path==="user")value={id:101,login:"odysseus"};
      else if(path.endsWith("/pulls/7"))value={number:7,state:s.merged?"closed":"open",draft:s.draft,merged:s.merged,merge_commit_sha:squash,head:{sha:s.mode==="changed-head"?"e".repeat(40):head,repo:{full_name:repo}},base:{ref:"main",sha:base,repo:{full_name:repo}},milestone:{title:"0.44.0"}};
      else if(path.endsWith("git/ref/heads/main"))value={object:{sha:s.mode==="changed-base"?"d".repeat(40):base}};
      else if(path.includes("actions/workflows/ci.yml/runs?event=push"))value={workflow_runs:[]};
      else if(path.includes("actions/workflows/ci.yml/runs"))value={workflow_runs:[run(s.mode.startsWith("confirm-")&&!s.requested?90:91,"ci")]};
      else if(path.includes("actions/workflows/contract.yml/runs"))value={workflow_runs:[run(92,"contract")]};
      else if(path.includes("/attempts/1/jobs"))value={total_count:11,jobs:[{id:1,name:"changeset",status:"completed",conclusion:"success",run_id:91,head_sha:head},{id:2,name:"proof",status:"completed",conclusion:"success",run_id:91,head_sha:head},...categories.map((name,index)=>({id:index+3,name,status:"completed",conclusion:"skipped",run_id:91,head_sha:head}))]};
      else if(path.endsWith("actions/jobs/1/logs"))value=checkout+'"cadence": "confirmation"';
      else if(path.endsWith("actions/jobs/2/logs")) {
        if(s.mode==="revoked-during-proof"&&!s.revoked){const store=new GitReservationStore(root), snap=store.read();store.publish(snap,reservationTransition(snap.state,{kind:"revoke",maintainer:true,reason:"Abandon controlled fixture"},202,s.now));s.revoked=true;}
        value=checkout+"BRAIN_CANDIDATE_RECEIPT "+JSON.stringify({event:"ready_for_review",head,base,checkout:actual})+"\\nBRAIN_SELECTED_PROOF_RECEIPT "+JSON.stringify(selected)+"\\nAll selected hosted proof passed; remaining skips are planner-intended.";}
      else if(path.endsWith("git/commits/"+actual.sha))value={sha:actual.sha,tree:{sha:actual.tree},parents:actual.parents.map(sha=>({sha}))};
      else if(path.endsWith("git/commits/"+squash))value={sha:squash,tree:{sha:actual.tree},parents:[{sha:base}]};
      else if(path.endsWith("issues/9"))value={milestone:{title:s.mode==="wrong-milestone"?"0.43.1":"0.44.0"}};
      else throw new Error("Unexpected offline API "+path);
    } else throw new Error("Unexpected offline gh "+JSON.stringify(args));
    writeFileSync(file,JSON.stringify(s));console.log(typeof value==="string"?value:JSON.stringify(value));`); chmodSync(gh, 0o755);
  const preload = join(dir, "clock.ts");
  writeFileSync(preload, `import {readFileSync,writeFileSync} from "node:fs";const callbacks=new Map();let id=0;
    const originalSet=globalThis.setInterval,originalClear=globalThis.clearInterval,originalSleep=Bun.sleep;
    globalThis.setInterval=(callback,ms,...args)=>ms===60000?(callbacks.set(++id,callback),id):originalSet(callback,ms,...args);
    globalThis.clearInterval=timer=>callbacks.has(timer)?callbacks.delete(timer):originalClear(timer);
    Bun.sleep=async ms=>{if(ms!==60000)return originalSleep(ms);const file=${JSON.stringify(apiState)},state=JSON.parse(readFileSync(file,"utf8"));state.now+=ms;writeFileSync(file,JSON.stringify(state));for(const callback of callbacks.values())await callback();};`);
  const child = Bun.spawn([process.execPath, ...(mode.startsWith("confirm-") ? ["--preload", preload] : []), resolve(import.meta.dir, "../scripts/integrate.ts"), mode.startsWith("confirm-") ? "confirm" : "merge", "7", ...(mode.startsWith("confirm-") ? [] : ["--lease", mode === "wrong-id" ? "2".repeat(32) : id]), "--issues", "odysseus/brain-kit#9"], {
    cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err, dispatched: existsSync(sentinel), state: store.read().state };
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
