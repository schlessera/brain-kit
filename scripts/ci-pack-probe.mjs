// The consumer half of scripts/ci-pack.ts: imports and named probes run under
// Bun or Node from INSIDE a packed-consumer install.
//
// ci-pack.ts copies this file into the consumer directory and runs it there,
// so every bare specifier resolves through that install's node_modules (the
// packed tarballs and their declared dependencies) and never through the
// workspace. It is plain JavaScript because Node runs it too.
//
//   bun|node .brainkit-pack-probe.mjs '{"label":…,"imports":[…],"bunOnly":[…],"probes":[…]}'
//
// - `imports`: each must load to a module namespace.
// - `bunOnly`: each must load, or fail only on its documented `bun:` dependency.
// - `probes`: names from PROBES below, run in order after the imports.

const runtime = typeof Bun === "undefined" ? "Node" : "Bun";

async function staticMap() {
  const geo = await import("@schlessera/brain-geo/server");
  if (typeof geo.GeoClient !== "function") throw new Error("Packed geo server client is missing");
  const map = await new geo.GeoClient().staticMap({
    pins: [{ lat: 0, lon: 0, label: "Packed stop" }], background: "none", widthPx: 320,
  });
  if (!map.png || map.png.byteLength < 1000 || map.png[0] !== 137 || !map.text.includes("Stop 1: Packed stop")) {
    throw new Error(`Packed ${runtime} static map failed: ${map.reason}`);
  }
}

async function claudeBackendExport() {
  const claude = await import("@schlessera/brain-backend-claude");
  if (typeof claude.createClaudeBackend !== "function") {
    throw new Error("createClaudeBackend export is missing");
  }
}

// Core's seam contract suites import no bun: module, so unlike core itself
// they load under Node, which resolves them to the built dist/.
async function coreTestingSuites() {
  const coreTesting = await import("@schlessera/brain/testing");
  for (const suite of [
    "runEmbeddingProviderContract",
    "runCompletionProviderContract",
    "runAgentRunnerContract",
    "runSkillEmitterContract",
  ]) {
    if (typeof coreTesting[suite] !== "function") {
      throw new Error(`${runtime}: @schlessera/brain/testing is missing ${suite}`);
    }
  }
}

// The logo ships as files (#1424, #1425): every file the kit lists resolves
// through its `./brand/*` export to non-empty bytes in the install, and every
// manifest icon is one of them.
async function uiKitBrand() {
  const brand = await import("@schlessera/brain-ui-kit/brand");
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const brandFiles = [...brand.BRAND_MASTERS, ...brand.BRAND_RASTERS];
  if (brand.BRAND_MASTERS.length === 0 || brand.BRAND_RASTERS.length === 0) throw new Error("Packed ui-kit lists no brand files");
  for (const icon of brand.WEB_APP_MANIFEST_ICONS) {
    if (!brandFiles.includes(icon.src)) throw new Error(`Packed manifest icon ${icon.src} is not a shipped brand file`);
  }
  for (const file of brandFiles) {
    const path = fileURLToPath(import.meta.resolve(`${brand.BRAND_ASSET_SPECIFIER}${file}`));
    if (!path.includes("/node_modules/@schlessera/brain-ui-kit/assets/brand/") || readFileSync(path).length === 0) {
      throw new Error(`Packed ui-kit does not ship ${file} at its export: ${path}`);
    }
  }
}

// The packed `brain` bin with the packed speaking and travel modules: module
// loading, skill lint, the travel format and migration, and the photo, route
// and geo commands against an Odysseus fixture. Bun only: the CLI is Bun's.
async function travelCli() {
  if (runtime !== "Bun") throw new Error("The packed travel CLI probe runs under Bun");
  const { mkdirSync, symlinkSync } = await import("node:fs");
  const { resolve, join } = await import("node:path");
  const root = resolve("travel-fixture");
  mkdirSync(root, { recursive: true });
  symlinkSync(resolve("node_modules"), join(root, "node_modules"));
  const speaking = "@schlessera/brain-module-speaking";
  const travel = "@schlessera/brain-module-travel";
  const party = [{ name: "Odysseus", requirementsDoc: "people/odysseus.md" }];
  await Bun.write(join(root, "brain.config.json"), JSON.stringify({ modules: {
    [speaking]: { travelParty: party }, [travel]: {},
  } }));
  const source = "---\ntype: trip\ntitle: Ithaca headland\ntrip_status: done\nvisits: [{id: homecoming, date: null}]\n---\n";
  await Bun.write(join(root, "trips/headland.md"), source);
  const bin = resolve("node_modules/.bin/brain");
  async function run(args) {
    const child = Bun.spawn([bin, ...args, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw new Error(`Packed travel CLI failed: ${args.join(" ")}: ${err}`);
    return JSON.parse(out);
  }
  const listed = await run(["module", "list"]);
  if (listed.enabled.find((m) => m.name === "travel")?.types.join(",") !== "travel,trip,place") {
    throw new Error("Packed travel module did not load its taxonomy");
  }
  if ((await run(["module", "lint", "travel"])).errors !== 0) throw new Error("Packed travel skills failed lint");
  if (!(await run(["travel", "validate"])).validation.valid) throw new Error("Packed travel format rejected its fixture");
  if (!(await run(["travel", "migrate"])).migration.changed) throw new Error("Packed migration made no edit");
  const config = await Bun.file(join(root, "brain.config.json")).json();
  if (JSON.stringify(config.modules[travel].travelParty) !== JSON.stringify(party)) throw new Error("Packed migration lost party data");
  if ((await run(["travel", "migrate"])).migration.changed) throw new Error("Packed migration was not idempotent");
  if (await Bun.file(join(root, "trips/headland.md")).text() !== source) throw new Error("Packed migration rewrote content");
  const input = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABgAAAAMCAIAAAD3UuoiAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGElEQVQokWP4TyXAMGoQQTAaRoTBMA4jANNsXM4dShcqAAAAAElFTkSuQmCC", "base64");
  await Bun.write(join(root, "inputs/odysseus.png"), input);
  const photo = (await run(["travel", "photo", "inputs/odysseus.png", "--to", "photos"])).photo;
  const copy = photo.files[0];
  if (photo.files.length !== 1 || photo.errors.length !== 0 || copy.output !== "photos/odysseus.jpg"
    || copy.width !== 24 || copy.height !== 12 || copy.captured_at !== null || copy.location !== null) {
    throw new Error("Packed photo command returned an incorrect report");
  }
  const jpeg = Buffer.from(await Bun.file(join(root, copy.output)).arrayBuffer());
  if (jpeg.length !== copy.bytes || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("Packed photo command did not encode a JPEG");
  if (!Buffer.from(await Bun.file(join(root, "inputs/odysseus.png")).arrayBuffer()).equals(input)) throw new Error("Packed photo command changed its source");
  const repeated = (await run(["travel", "photo", "inputs/odysseus.png", "--to", "photos"])).photo;
  if (repeated.files[0]?.output !== "photos/odysseus-2.jpg") throw new Error("Packed photo command overwrote its first copy");
  const recording = `<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg><trkpt lat="0" lon="0"/><trkpt lat="0" lon="0.001"/></trkseg></trk></gpx>`;
  await Bun.write(join(root, "recordings/odysseus.gpx"), recording);
  const imported = (await run(["travel", "route", "recordings/odysseus.gpx", "--to", "routes"])).route;
  if (imported.source_kind !== "local_gpx" || imported.points !== 2 || imported.distance_km !== 0.111195 || imported.ascent_m !== null) {
    throw new Error("Packed route CLI did not parse the nonempty GPX with honest unknown elevations");
  }
  if (!(await Bun.file(join(root, imported.gpx)).text()).includes("<trkpt")) throw new Error("Packed route CLI wrote no geometry");
  if (await Bun.file(join(root, "recordings/odysseus.gpx")).text() !== recording) throw new Error("Packed route CLI changed its source");
  const summary = await run(["geo", "track", "recordings/odysseus.gpx"]);
  if (summary.operation !== "track" || summary.geometry[0]?.length !== 2 || summary.counts.retained !== 2 || summary.measurements.distance.value <= 0) {
    throw new Error("Packed geo track CLI lost its nonempty source/measurement contract");
  }
  const map = await run(["geo", "map", "recordings/odysseus.gpx", "--no-background", "--width", "320", "--out", "walk.png"]);
  const png = Buffer.from(await Bun.file(join(root, "walk.png")).arrayBuffer());
  if (map.operation !== "map" || map.kind !== "track_only" || map.artifact?.bytes !== png.length || png[0] !== 137 || png.length < 1000 || map.png !== undefined || map.svg !== undefined) {
    throw new Error("Packed geo map CLI did not write a qualified local PNG");
  }
  if (await Bun.file(join(root, "recordings/odysseus.gpx")).text() !== recording) throw new Error("Packed geo CLI changed its source");
}

async function diagramsStatic() {
  const { spawnSync } = await import("node:child_process");
  const code = `
    const assert = require("node:assert/strict");
    if (typeof Bun === "undefined") {
      const { registerHooks } = require("node:module");
      registerHooks({ resolve(specifier, context, next) {
        if (["react","react-dom","@schlessera/brain-ui-react","@schlessera/brain-ui-kit","@schlessera/brain-ui-sdk"].some(root=>specifier===root||specifier.startsWith(root+"/"))) throw Error("Static diagram imported a UI runtime: " + specifier);
        return next(specifier, context);
      }});
    }
    assert.equal(typeof document,"undefined"); assert.equal(typeof window,"undefined");
    import("@schlessera/brain-module-diagrams/render").then(async renderer => {
      const source=JSON.stringify({schema_version:1,type:"architecture",title:"Raft",desc:"Odysseus prepares the raft.",size:"fit",nodes:[{id:"raft",label:"Raft",role:"input",at:[32,32],size:[128,64]}],edges:[]});
      const svg=await renderer.toStatic(source,{theme:"print"});
      assert(svg.startsWith("<svg "));assert(svg.includes('data-theme="print"'));assert(svg.includes("Odysseus prepares the raft."));assert.equal(renderer.diagramsStaticPack.renderers[0].needsBrowser,false);
      const { readFileSync }=require("node:fs"),{dirname,join}=require("node:path"),packageRoot=dirname(require.resolve("@schlessera/brain-module-diagrams/package.json"));
      for(const name of ["architecture","flowchart","state-machine","tree","er","dependency","architecture-containment"]){
        const example=readFileSync(join(packageRoot,"skills/diagram/references/examples/"+name+".diagram.yaml"),"utf8");
        for(const theme of ["light","dark","print"]){const drawn=await renderer.toStatic(example,{theme});assert(drawn.includes('data-theme="'+theme+'"'));assert(drawn.includes(JSON.parse(example).title));}
      }

      const fs=require("node:fs"),path=require("node:path"),url=require("node:url"),crypto=require("node:crypto");
      const directory=path.dirname(require.resolve("@schlessera/brain-module-diagrams/package.json"));
      const fonts=await import(url.pathToFileURL(path.join(directory,typeof Bun === "undefined"?"dist/fonts.js":"src/fonts.ts")).href);
      assert.equal((fonts.diagramFontCss().match(/@font-face/g)||[]).length,4);
      assert(fonts.embedDiagramFonts(svg).includes("data:font/ttf;base64,"));
      const hashes={2:"44ce4a84f20d60f24539bd0cef11f79c29e38609e0f8adf18551c9794a5d9dc3",4:"df54dbfafba61d4911eb3dab9bba2d20531fb009f01d64dd42fa96ab862584d8",6:"b4fc14ec283d54236fd302cdb92546f98ae0ff061ca5ee23453a02bdf4628791",7:"50357df108c5d297ec4ece76aeddf49561f3794f67af077cfc2c711b7a75b439"};
      for(const [number,hash] of Object.entries(hashes))assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(directory,"assets/fonts/"+number+".ttf"))).digest("hex"),hash);
      for(const family of ["jetbrainsmono","plusjakartasans"])assert(fs.readFileSync(path.join(directory,"assets/licenses/"+family+".txt"),"utf8").includes("SIL OPEN FONT LICENSE"));
      if(typeof Bun !== "undefined"){const helpers=await import("@schlessera/brain/module");assert.equal(typeof helpers.markdownFences,"function");assert.equal(typeof helpers.renderHtmlArtifact,"function");}

    }).catch(error=>{console.error(error);process.exitCode=1;});
  `;
  const child=spawnSync(process.execPath,["-e",code],{encoding:"utf8"});
  if(child.status!==0 || child.signal) throw Error(`Packed ${runtime} static diagram failed: ${child.stderr}`);
}

const PROBES = {
  "diagrams-static": diagramsStatic,
  "geo-static-map": staticMap,
  "claude-backend-export": claudeBackendExport,
  "core-testing-suites": coreTestingSuites,
  "ui-kit-brand": uiKitBrand,
  "travel-cli": travelCli,
};

const spec = JSON.parse(process.argv[2] ?? "null");
if (!spec || typeof spec.label !== "string") throw new Error("usage: ci-pack-probe.mjs '<json spec>'");

for (const name of spec.imports ?? []) {
  const loaded = await import(name);
  if (!loaded || typeof loaded !== "object") {
    throw new Error(`${runtime} failed to import ${name}`);
  }
}
for (const name of spec.bunOnly ?? []) {
  try {
    await import(name);
  } catch (error) {
    const message = `${error?.code ?? ""}: ${error?.message ?? error}`;
    if (!message.includes("bun:")) {
      throw new Error(`${name} failed for a reason other than its documented bun: dependency:\n${message}`);
    }
  }
}
for (const name of spec.probes ?? []) {
  const probe = PROBES[name];
  if (!probe) throw new Error(`Unknown pack probe ${name}`);
  await probe();
}
console.log(`${spec.label}: ${runtime} ok`);
