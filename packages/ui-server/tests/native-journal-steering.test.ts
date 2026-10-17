import { expect, test } from "bun:test";
import { steeringReferences } from "../src/brain/journal-reference-roles.js";
import { journalSteeringInputs, nativeJournalSteeringInputs } from "../src/brain/journal-steering.js";
import type { JournalSnapshot } from "../src/brain/journal-snapshot.js";

test("native steering follows sealed configuration references without retaining a content baseline", async () => {
  const inputs = new Map([
    ["brain.config.ts", 'import "./config/helper.ts"; throw new Error("never execute");'],
    ["config/helper.ts", 'import "./routes.json";'],
    ["config/routes.json", '{"destination":"Ithaca"}'],
    ["notes/odysseus.md", "Odysseus prepares the voyage."],
  ]);
  const snapshot: JournalSnapshot = { missing: [], entries: [...inputs].map(([path, text]) => ({ path, scope: "", kind: "file", mode: 0o600, bytes: Buffer.byteLength(text), stamp: `sealed:${path}`, ignored: false })) };
  const reads: string[] = [];
  const result = await nativeJournalSteeringInputs([snapshot], async (entry, maximum) => {
    expect(maximum).toBe(1024 * 1024); reads.push(entry.path); return Buffer.from(inputs.get(entry.path)!);
  });
  expect([...result.paths].sort(), "NATIVE_STEERING_TRANSITIVE_WITHOUT_CAS").toEqual(["brain.config.ts", "config/helper.ts", "config/routes.json"]);
  expect(result.unavailable).toEqual(["brain.config.ts"]);
  expect(reads).not.toContain("notes/odysseus.md");
  expect(snapshot.entries.every(entry => entry.hash === undefined)).toBe(true);
});


test("only startup consumers seed configuration, not dependency or cloned manifests", async () => {
  const inputs = new Map([
    ["package.json", '{"name":"ithaca"}'],
    ["node_modules/a/package.json", '{"name":"incidental"}'],
    ["workspaces/odyssey-tools/package.json", '{"scripts":{"start":"bun ./start.ts"}}'],
    ["workspaces/odyssey-tools/start.ts", 'throw new Error("unused");'],
  ]);
  const snapshot: JournalSnapshot = { missing: [], entries: [...inputs].map(([path, text]) => ({ path, scope: path.startsWith("workspaces/") ? "workspaces/odyssey-tools" : "", kind: "file", mode: 0o600, bytes: Buffer.byteLength(text), stamp: `sealed:${path}`, ignored: path.startsWith("node_modules/") })) };
  const reads: string[] = [];
  const result = await nativeJournalSteeringInputs([snapshot], async entry => {
    reads.push(entry.path); return Buffer.from(inputs.get(entry.path)!);
  });
  expect([...result.paths], "CONSUMER_SEEDS_EXCLUDE_INCIDENTAL_MANIFESTS").toEqual(["package.json"]);
  expect(result.unavailable, "INCIDENTAL_DEPENDENCY_NOT_COVERAGE_NOISE").not.toContain("node_modules/a/package.json");
  expect(reads).toEqual(["package.json"]);
});


test("Bun module consumers discover nearest nested package scope without activating package scripts", async () => {
  const inputs = new Map([
    ["brain.config.ts", 'import "./config/navigator/start.ts";'],
    ["config/navigator/start.ts", 'export const route = "Ithaca";'],
    ["config/navigator/package.json", '{"type":"module","scripts":{"unused":"bun ./unused.ts"}}'],
    ["config/navigator/unused.ts", 'throw new Error("not consumed");'],
    ["config/incidental/package.json", '{"type":"module"}'],
    ["workspaces/ithaca/.pi/extensions/voyage.ts", 'import "../../navigation/start.ts";'],
    ["workspaces/ithaca/navigation/start.ts", 'export const route = "Ithaca";'],
    ["workspaces/ithaca/navigation/package.json", '{"type":"module"}'],
    ["workspaces/ithaca/incidental/package.json", '{"type":"module"}'],
  ]);
  const snapshot: JournalSnapshot = { missing: [], entries: [...inputs].map(([path, text]) => ({ path, scope: path.startsWith("workspaces/") ? "workspaces/ithaca" : "", kind: "file", mode: 0o600, bytes: Buffer.byteLength(text), stamp: `sealed:${path}`, ignored: false })) };
  // The native seed index omits incidental configuration entirely. Discovery
  // must use same-scope lookup, without depending on a full content snapshot.
  const result = await nativeJournalSteeringInputs([{missing: [], entries: snapshot.entries.filter(entry => entry.path === "brain.config.ts" || entry.path.includes(".pi/"))}], async entry => Buffer.from(inputs.get(entry.path)!), path => snapshot.entries.find(entry => entry.path === path));
  for (const path of ["config/navigator/package.json", "workspaces/ithaca/navigation/package.json"]) expect(result.paths.has(path), `CONSUMED_NESTED_PACKAGE_${path}`).toBe(true);
  for (const path of ["config/incidental/package.json", "workspaces/ithaca/incidental/package.json", "config/navigator/unused.ts"]) expect(result.paths.has(path), `UNUSED_CONFIGURATION_${path}`).toBe(false);
});

for (const reader of ["retained", "native"] as const) test(`${reader} steering classifies supported input roles without promoting output/data literals`, async () => {
  const inputs = new Map([
    ["CLAUDE.md", "@./guide\n`@./data`\n\n```md\n@./output\n```"],
    ["guide", "Athena advises the voyage."],
    ["brain.config.ts", 'import "./resources/brain.db" with { type: "text" }; export default { db: "./cache/index.sqlite", output: "./output", script: "./data" };'],
    ["bunfig.toml", 'preload = ["./startup.ts", "./cache/index.sqlite", "./cache/index.sqlite-wal", "./cache/index.sqlite-shm", "./cache/index.sqlite-journal"]\n[install]\ncache = "./output"'],
    ["startup.ts", 'import "./helper.js"; import text from "./instructions" with {type:"text"}; const output = "./data";'],
    ["package.json", JSON.stringify({scripts:{start:"bun ./entry.ts ./data", export:"cat ./output"}, output:"./output"})],
    ["helper.ts", 'export {};'],
    ["entry.ts", 'export {};'],
    [".claude/settings.json", JSON.stringify({hooks:{PreToolUse:[{hooks:[{type:"command",command:"bun",args:["./hook.ts","./data"]}]}]}})],
    ["hook.ts", 'export {};'],
    [".mcp.json", JSON.stringify({mcpServers:{voyage:{command:"node",args:["./mcp.js","./data"]}}})],
    ["mcp.js", 'export {};'],
    [".pi/settings.json", JSON.stringify({prompts:["../instructions"], extensions:["../extension.ts"], packages:["npm:unavailable"]})],
    ["extension.ts", 'export {};'],
    ["brain.config.json", JSON.stringify({modules:{"./voyage":{}}})],
    ["voyage/module.ts", 'export {};'],
    ["instructions", "Athena guides the voyage."], ["resources/brain.db", "A genuine imported text resource."],
    ["cache/index.sqlite", "index"], ["cache/index.sqlite-wal", "wal"], ["cache/index.sqlite-shm", "shm"], ["cache/index.sqlite-journal", "journal"],
    ["output", "ordinary output"], ["data", "ordinary data"],
  ]);
  const snapshot: JournalSnapshot = {missing:[],entries:[...inputs].map(([path,text])=>({path,scope:"",kind:"file",mode:0o600,bytes:Buffer.byteLength(text),stamp:path,hash:path,ignored:false}))};
  const options = { resolvedIndexPaths: ["cache/index.sqlite"] };
  const result = reader === "native"
    ? await nativeJournalSteeringInputs([snapshot], async entry => Buffer.from(inputs.get(entry.path)!), undefined, options)
    : journalSteeringInputs([snapshot], hash => Buffer.from(inputs.get(hash)!), options);
  expect([...result.paths].sort(), "STEERING_INPUT_ROLES_ONLY").toEqual([
    ".claude/settings.json", ".mcp.json", ".pi/settings.json", "CLAUDE.md", "brain.config.json", "brain.config.ts", "bunfig.toml", "entry.ts", "extension.ts", "guide", "helper.ts", "hook.ts", "instructions", "mcp.js", "package.json", "resources/brain.db", "startup.ts", "voyage/module.ts",
  ]);
  expect(result.unavailable).toEqual([".pi/settings.json", "brain.config.ts", "package.json"]);
});

for (const reader of ["retained", "native"] as const) test(`${reader} steering bounds opaque, computed, unreadable and out-of-scope inputs`, async () => {
  const inputs = new Map([
    ["bunfig.toml", 'preload = ["./unreadable.ts", "./opaque.ts", "./missing.ts", "../escape.ts", "./workspaces/other/run.ts", "./context/policies/governance.md"]'],
    ["unreadable.ts", "export {};"], ["opaque.ts", 'import(variable); readFileSync("./not-proven");'],
    ["not-proven", "ordinary data"], ["workspaces/other/run.ts", "export {};"], ["context/policies/governance.md", "policy"],
  ]);
  const snapshot: JournalSnapshot = {missing:[],entries:[...inputs].map(([path,text])=>({path,scope:path.startsWith("workspaces/")?"workspaces/other":"",kind:"file",mode:0o600,bytes:Buffer.byteLength(text),stamp:path,hash:path,ignored:false}))};
  const reads: string[] = [];
  const read = (path: string) => { reads.push(path); if(path === "unreadable.ts") throw Error("unreadable fixture"); return Buffer.from(inputs.get(path)!); };
  const result = reader === "native" ? await nativeJournalSteeringInputs([snapshot], async entry => read(entry.path)) : journalSteeringInputs([snapshot], read);
  expect([...result.paths].sort()).toEqual(["bunfig.toml", "opaque.ts", "unreadable.ts"]);
  expect(result.unavailable).toEqual(["bunfig.toml", "opaque.ts", "unreadable.ts"]);
  expect(reads).not.toContain("workspaces/other/run.ts"); expect(reads).not.toContain("context/policies/governance.md");
  expect(reads).not.toContain("not-proven");
});


test("configuration consumers and imported data retain distinct roles and command working directories", () => {
  const manifest = JSON.stringify({scripts:{start:"bun ./startup.ts ./ordinary"}});
  expect(steeringReferences("tools/package.json",manifest,undefined,true)).toEqual({references:[{path:"./startup.ts",base:"file",module:true}],unknown:false});
  expect(steeringReferences("tools/package.json",manifest)).toEqual({references:[],unknown:false});
  const settings = JSON.stringify({hooks:{PreToolUse:[{hooks:[{type:"command",command:"bun ./hook.ts ./ordinary"}]}]}});
  expect(steeringReferences(".claude/settings.json",settings,undefined,true)).toEqual({references:[{path:"./hook.ts",base:"scope",module:true}],unknown:false});
  expect(steeringReferences(".claude/settings.json",settings)).toEqual({references:[],unknown:false});
  expect(steeringReferences(".pi/settings.json",JSON.stringify({prompts:["!../ordinary"]}),undefined,true)).toEqual({references:[],unknown:true});
});
