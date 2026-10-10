/** Materialize current shipped skill and an explicitly clock-controlled CLI tool. */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Fixture } from "./fixture";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function nativeSurfaceFiles(source:string,fixture:Fixture){
  return {
    ".claude/skills/content-hygiene/SKILL.md":readFileSync(join(source,"packages/core/skills/content-hygiene/SKILL.md"),"utf8"),
    "brain.config.json":JSON.stringify({reranker:{enabled:false},taxonomy:{types:{note:{dir:fixture.inbox??"notes",inbox:true}}}},null,2),
    "AGENTS.md":"# Fictional hygiene brain\n\nUse the shipped content-hygiene skill. The private brain CLI tool clock is 2026-07-12T12:00:00Z; document reference day is 2026-07-12. Native agent/auth/provider clocks remain real. Do not dismiss or snooze findings.\n",
    "bin/brain":`#!/bin/sh\nexport BRAIN_HYGIENE_CLOCK='2026-07-12T12:00:00Z'\nexec ${quote(process.execPath)} --preload ${quote(join(source,"scripts/evals/mechanical-hygiene/clock.ts"))} ${quote(join(source,"packages/core/src/cli/brain.ts"))} "$@"\n`,
  };
}
export function installNativeSurface(root: string, source: string, fixture: Fixture) {
  root = resolve(root); source = resolve(source);
  const files=nativeSurfaceFiles(source,fixture);
  mkdirSync(join(root,".claude/skills/content-hygiene"),{recursive:true});
  mkdirSync(join(root,".brain/scratch"),{recursive:true});mkdirSync(join(root,"bin"),{recursive:true});
  for(const [path,text]of Object.entries(files))writeFileSync(join(root,path),text);
  chmodSync(join(root,"bin/brain"),0o755);
  return { root, source, bin: join(root, "bin") };
}
