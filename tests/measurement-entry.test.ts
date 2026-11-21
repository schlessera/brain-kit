import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { enterMeasurement, REAL_MEASUREMENT_WARNING } from "../scripts/measurement-entry";
const ROOT=join(import.meta.dir,"..");
for (const entry of ["measure-turn-surface-live.ts","measure-turn-surface-tokens.ts","measure-show-block.ts","measure-show-block-server.ts","measure-real-provider-dispatch.ts","measure-pi-schema.ts","measure-sync-judge.ts"]) {
  test(`${entry} refuses missing authorization and preserves explicitly authorized live access`, () => {
    let installs=0; const warnings: string[]=[];
    const effects={installOffline(){installs++;},warn(message:string){warnings.push(message);}};
    expect(()=>enterMeasurement({entry,argv:[]},effects)).toThrow("before runtime import");
    expect(installs).toBe(0); expect(warnings).toEqual([]);
    const protocol=entry.startsWith("measure-turn-surface-");
    expect(enterMeasurement({entry,argv:protocol?[]:["--allow-real-provider"],liveEval:protocol?"587":undefined},effects)).toBe("live");
    expect(installs).toBe(0); expect(warnings).toEqual([REAL_MEASUREMENT_WARNING]);
  });
}
test("offline measurements install the guard even with unrelated live environment metadata", () => {
  for(const input of [{entry:"measure-claude-runtime.ts",argv:[],liveEval:"587"},{entry:"measure-turn-surface-live.ts",argv:[],liveEval:"587_OFFLINE"}]) {
    let installs=0,warnings=0;
    expect(enterMeasurement(input,{installOffline(){installs++;},warn(){warnings++;}})).toBe("offline");
    expect(installs).toBe(1);expect(warnings).toBe(0);
  }
});
test("every runnable measurement entry admits before runtime dependencies and nested capture shares admission", async () => {
  for await (const file of new Bun.Glob("measure-*.ts").scan({cwd:join(ROOT,"scripts")})) {
    const source=readFileSync(join(ROOT,"scripts",file),"utf8");
    if(["measure-sonnet55-cost.ts","measure-suggestions.ts","measure-kv-runs.ts"].includes(file)) {
      expect(source,file).not.toContain("measurement-entry-preload");
    } else expect(source.split("\n")[0],file).toContain("measurement-entry-preload.ts");
  }
  for(const file of ["capture-turn-surface.ts","turn-surface-overlap.ts","show-block-schema-forms.ts"])
    expect(readFileSync(join(ROOT,"scripts",file),"utf8").split("\n")[0]).toContain("measurement-entry-preload.ts");
  const preload=readFileSync(join(ROOT,"scripts/measurement-entry-preload.ts"),"utf8");
  expect(preload).not.toContain("await ");
  expect(preload).toContain("installOffline: () => { installNetworkGuard(); }");
  expect(readFileSync(join(ROOT,"scripts/measure-real-provider-dispatch.ts"),"utf8")).toContain('String(prior), "--allow-real-provider"');
  expect(readFileSync(join(ROOT,"scripts/measure-show-block-server.ts"),"utf8")).toContain("...args, ...measurementAuthorizationArgs");
});
for (const [entry, argv] of [
 ["measure-show-block.ts", ["--suggestions", "--schema-cost"]],
 ["measure-show-block-server.ts", ["--report", "saved.json"]],
 ["measure-show-block-server.ts", ["--inspect-suggestions"]],
 ["measure-real-provider-dispatch.ts", ["claude", "--dry-run"]],
 ["measure-real-provider-dispatch.ts", ["--server", "claude", "/tmp/ithaca", "dry", "0"]],
 ["measure-turn-surface-live.ts", ["--offline"]],
] as const) test(`${entry} ${argv.join(" ")} stays offline with or without authorization`, () => {
 for (const authorized of [false,true]) {
  let installs=0,warnings=0;
  expect(enterMeasurement({entry,argv:[...argv,...(authorized?["--allow-real-provider"]:[])],liveEval:authorized?"587":undefined},
   {installOffline(){installs++;},warn(){warnings++;}})).toBe("offline");
  expect(installs).toBe(1);expect(warnings).toBe(0);
 }
});
for(const [entry,argv] of [["measure-show-block.ts",["--tokens"]],["measure-show-block.ts",["--suggestions","--tokens"]],["measure-show-block-server.ts",["--classify"]],["measure-real-provider-dispatch.ts",["--server","claude","/tmp/ithaca","live","0","--dry-run"]]] as const)
 test(`${entry} ${argv.join(" ")} requires live authorization`,()=>expect(()=>enterMeasurement({entry,argv},{installOffline(){},warn(){}})).toThrow("before runtime import"));
