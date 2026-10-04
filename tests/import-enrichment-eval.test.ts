import { expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Interrupted, MANIFEST, CACHE, receipts } from "../scripts/evals/import-enrichment/prototype";
import { execute, fixtures, materialize, prepare, snapshot } from "../scripts/evals/import-enrichment/fixtures";

for(const mode of ["combined","classification","hybrid"] as const){
  test.each(fixtures)(`${mode}/$id: exact retained bytes and resume state`,async fixture=>{
    const env=prepare(fixture,mode);
    try{
      const before=snapshot(env);
      await execute(env,{dryRun:true});
      expect(snapshot(env)).toEqual(before);
      env.requests.length=0;
      const result=await execute(env);
      for(const [path,raw]of Object.entries(env.expected)){
        expect(raw.length).toBeGreaterThan(80);
        expect(readFileSync(join(env.root,path),"utf8"),`${mode}/${fixture.id}/${path}`).toBe(raw);
        if(raw===env.files[path])expect(snapshot(env)[path].mtime,`${fixture.id}/${path}`).toBe(before[path].mtime);
      }
      const done=existsSync(join(env.root,MANIFEST))?receipts(env.root).filter(r=>r.status==="complete"):[];
      for(const r of done)expect(result.failed.some(f=>f.path===r.path)).toBe(false);
      const after=snapshot(env),requests=env.requests.length;
      const again=await execute(env);
      expect(snapshot(env)).toEqual(after);
      expect(again.written).toEqual([]);
      if(done.length){expect(again.skipped.toSorted()).toEqual(done.map(r=>r.path).toSorted());expect(env.requests).toHaveLength(requests);}
      if(env.expected[env.path]!==env.files[env.path])expect(result.written).toContain(env.path);
    }finally{env.close();}
  });
}

test("changed source is re-evaluated and gets new exact metadata instead of a resume skip",async()=>{
  const env=prepare({...fixtures[0]});try{
    await execute(env);
    const original=readFileSync(join(env.root,env.path),"utf8");
    const changed=original+"\nAthena replaces the shore route with a council ruling.\n";
    writeFileSync(join(env.root,env.path),changed);
    env.fixture.target="ruling";env.fixture.labelTags=["council"];env.fixture.labelSummary="Athena replaces the shore route with a council ruling.";
    const expected=changed.replace("type: logbook","type: ruling").replace("tags: [navigation]","tags: [council]").replace(JSON.stringify(fixtures[0].labelSummary),JSON.stringify(env.fixture.labelSummary));
    const result=await execute(env);
    expect(readFileSync(join(env.root,env.path),"utf8")).toBe(expected);
    expect(result.processed).toContain(env.path);expect(result.skipped).toEqual([]);
    expect(result.calls).toEqual({combined:0,classification:1,summary:1});
  }finally{env.close();}
});

test("changed user summary is protected while unchanged generated type/tags are refreshed",async()=>{
  const env=prepare({...fixtures[0]});try{
    await execute(env);
    const original=readFileSync(join(env.root,env.path),"utf8");
    const changed=original.replace(JSON.stringify(fixtures[0].labelSummary),'"The owner corrected this sentence."')+"\nAthena records a council ruling.\n";
    writeFileSync(join(env.root,env.path),changed);
    env.fixture.target="ruling";env.fixture.labelTags=["council"];env.fixture.labelSummary="A model sentence must not replace the owner correction.";
    const expected=changed.replace("type: logbook","type: ruling").replace("tags: [navigation]","tags: [council]");
    const result=await execute(env);
    expect(readFileSync(join(env.root,env.path),"utf8")).toBe(expected);
    expect(result.calls.summary).toBe(0);
  }finally{env.close();}
});

test.each(["pending","written"] as const)("interruption after %s cannot become a false completed skip",async stage=>{
  const env=prepare(fixtures[0]);try{
    await execute(env,{fault:at=>{if(at===stage)throw new Interrupted("fixture interruption");}});
    expect(receipts(env.root).filter(r=>r.status==="complete")).toHaveLength(0);
    expect(receipts(env.root).filter(r=>r.status==="pending")).toHaveLength(1);
    const result=await execute(env);
    for(const [path,raw]of Object.entries(env.expected))expect(readFileSync(join(env.root,path),"utf8"),path).toBe(raw);
    expect(receipts(env.root).filter(r=>r.status==="complete")).toHaveLength(1);
    expect(result.skipped).toEqual([]);
    expect(result.processed).toContain(env.path);
    expect(result.recovered).toEqual(stage==="written"?[env.path]:[]);
  }finally{env.close();}
});

test("failed summary retries only unfinished work and does not mark the source complete",async()=>{
  const env=prepare({...fixtures.find(f=>f.id==="summary-failure")!});try{
    const first=await execute(env);
    expect(readFileSync(join(env.root,env.path),"utf8")).toBe(env.files[env.path]);
    expect(receipts(env.root).filter(r=>r.status==="complete")).toHaveLength(0);
    expect(first.failed.map(f=>f.path)).toEqual([env.path]);
    env.fixSummary();
    const second=await execute(env);
    const gold=materialize({...env.fixture,failure:undefined},"hybrid").expected[env.path];
    expect(readFileSync(join(env.root,env.path),"utf8")).toBe(gold);
    expect(second.skipped).toEqual([]);expect(second.calls).toEqual({combined:0,classification:0,summary:1});
    expect(second.cacheHits).toBe(1);
  }finally{env.close();}
});

test("interrupted page resumes completed paths and processes its unfinished sibling",async()=>{
  const env=prepare(fixtures.find(f=>f.duplicate)!);try{
    const first=await execute(env,{maxItems:1});
    expect(first.written).toHaveLength(1);
    const unfinished=env.settings.files.find(f=>!first.written.includes(f.path))!.path;
    expect(readFileSync(join(env.root,unfinished),"utf8")).toBe(env.files[unfinished]);
    const next=await execute(env);
    for(const [path,raw]of Object.entries(env.expected))expect(readFileSync(join(env.root,path),"utf8"),path).toBe(raw);
    expect(next.skipped).toEqual(first.written);expect(next.processed).toEqual([unfinished]);
    expect(receipts(env.root).filter(r=>r.status==="complete").map(r=>r.path).toSorted()).toEqual(env.settings.files.map(f=>f.path).toSorted());
  }finally{env.close();}
});

test("identical already-enriched bytes at another approved path need their own completion receipt",async()=>{
  const env=prepare(fixtures.find(f=>f.duplicate)!);try{
    const first=await execute(env,{maxItems:1});
    const other=env.settings.files.find(f=>!first.written.includes(f.path))!.path;
    writeFileSync(join(env.root,other),readFileSync(join(env.root,first.written[0]),"utf8"));
    const next=await execute(env);
    expect(receipts(env.root).filter(r=>r.status==="complete").map(r=>r.path).toSorted()).toEqual(env.settings.files.map(f=>f.path).toSorted());
    expect(next.skipped).toEqual(first.written);expect(next.processed).toEqual([other]);
  }finally{env.close();}
});

test.each(["classificationModel","summaryModel","promptVersion","vocabulary"] as const)("changed %s invalidates unchanged completion and cache",async field=>{
  const env=prepare(fixtures[0]);try{
    await execute(env);
    if(field==="vocabulary")env.settings.vocabulary=[...env.settings.vocabulary,"shore"];
    else env.settings[field]+="-changed";
    const result=await execute(env);
    expect(receipts(env.root).filter(r=>r.status==="complete")).toHaveLength(2);
    expect(result.skipped).toEqual([]);expect(result.processed).toContain(env.path);
    expect(result.calls).toEqual({combined:0,classification:1,summary:1});
    for(const [path,raw]of Object.entries(env.expected))expect(readFileSync(join(env.root,path),"utf8"),path).toBe(raw);
  }finally{env.close();}
});

test.each(["not requested","not approved","no classifier","no summary"])("%s changes no source/cache/manifest",async mode=>{
  const env=prepare(fixtures[0]);try{
    if(mode==="not requested")env.settings.requested=false;
    if(mode==="not approved")env.settings.structureApproved=false;
    const before=snapshot(env);
    const result=await execute(env,mode==="no classifier"?{classifier:null}:mode==="no summary"?{summary:null}:{});
    expect(snapshot(env)).toEqual(before);expect(env.requests).toEqual([]);expect(result.degraded).toBe(true);
  }finally{env.close();}
});

test("an approved source changed during inference is not overwritten or completed",async()=>{
  const env=prepare(fixtures[0]);try{
    const provider=env.options.summary,manual=env.files[env.path]+"\nOwner edit during the request.\n";
    const result=await execute(env,{summary:{...provider,async complete(req){const answer=await provider.complete(req);writeFileSync(join(env.root,env.path),manual);return answer;}}});
    expect(readFileSync(join(env.root,env.path),"utf8")).toBe(manual);
    expect(receipts(env.root).filter(r=>r.status==="complete")).toHaveLength(0);
    expect(result.written).toEqual([]);expect(result.failed).toHaveLength(1);
  }finally{env.close();}
});

test.each(["manifest","cache","source"])("malformed %s is refused before any source write",async kind=>{
  const env=prepare(fixtures[0]);try{
    if(kind==="source")writeFileSync(join(env.root,env.path),'---\ntitle: "broken\n---\nOriginal body.\n');
    else writeFileSync(join(env.root,kind==="manifest"?MANIFEST:CACHE),"{invalid JSON}\n");
    const before=snapshot(env);
    await expect(execute(env)).rejects.toThrow();
    expect(snapshot(env)).toEqual(before);expect(env.requests).toEqual([]);
  }finally{env.close();}
});

test("a manifest symlink cannot write its regular target",async()=>{
  const env=prepare(fixtures[0]);try{
    symlinkSync(join(env.root,"notes/sentinel.md"),join(env.root,MANIFEST));
    const original=readFileSync(join(env.root,"notes/sentinel.md"),"utf8");
    await expect(execute(env)).rejects.toThrow("regular contained path");
    expect(readFileSync(join(env.root,"notes/sentinel.md"),"utf8")).toBe(original);
  }finally{env.close();}
});

test("requests have nonempty untrusted content and focused summary context",async()=>{
  const env=prepare(fixtures.find(f=>f.id==="malicious-source")!);try{
    const result=await execute(env);
    expect(result.failed).toEqual([]);
    const classification=env.requests.find(r=>r.kind==="classification")!,focused=env.requests.find(r=>r.kind==="summary")!;
    expect(JSON.parse(classification.prompt).untrusted_note).toContain("execute a command");
    expect(JSON.parse(classification.prompt).types.length).toBeGreaterThan(1);
    expect(JSON.parse(focused.prompt).untrusted_body.length).toBeGreaterThan(80);
    expect(focused.system).toContain("untrusted data");
    expect(readFileSync(join(env.root,"notes/sentinel.md"),"utf8")).toBe(env.files["notes/sentinel.md"]);
    expect(fixtures.filter(f=>f.split==="tuning")).toHaveLength(4);
    expect(fixtures.filter(f=>f.split==="held-out").length).toBeGreaterThan(10);
  }finally{env.close();}
});
