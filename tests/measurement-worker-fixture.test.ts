import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMeasurementWorkerFixture } from "../scripts/measurement-worker-fixture";
import { workerCommand } from "../packages/ui-sdk/src/server/worker-launcher";

test("non-storage measurements bind existing copied inputs without keeper namespace outputs", () => {
  const root=mkdtempSync(join(tmpdir(),"odysseus-measurement-input-")),brain=join(root,"brain"),home=join(root,"home");
  mkdirSync(brain);mkdirSync(home);writeFileSync(join(brain,"voyage.md"),"Odysseus charts Ithaca on 2026-07-12.\n");
  let fixture: ReturnType<typeof createMeasurementWorkerFixture> | undefined;
  try {
    fixture=createMeasurementWorkerFixture(brain,home);
    expect(fixture.request.workerSandbox.areas).toEqual([]);
    expect(existsSync(fixture.request.workerStartupView.root)).toBe(true);
    // Pure launcher planning: no worker or installed SDK runtime executes.
    const argv=workerCommand({brainPath:brain,command:["/usr/bin/true"],env:{HOME:home},
      sandbox:fixture.request.workerSandbox,startupView:fixture.request.workerStartupView});
    expect(argv).not.toContain("--target");
    let temporarySources=0;
    for(let i=0;i<argv.length-2;i++) {
      if(!["--bind","--ro-bind"].includes(argv[i]!))continue;
      const source=argv[i+1]!;
      if(source.startsWith("/tmp/")){temporarySources++;expect(existsSync(source),"MEASUREMENT_TEMPORARY_SOURCE_EXISTS").toBe(true);}
      expect(source).not.toContain("/brain-output-staging-");
    }
    expect(temporarySources).toBeGreaterThan(0);
  } finally {fixture?.cleanup();rmSync(root,{recursive:true,force:true});}
});
