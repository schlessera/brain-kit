/**
 * The packed ui-server reads the graph and voice vocabulary through the
 * packed optional core peer, in an installed consumer (#697).
 *
 * Proves, against a CLI-produced index and the tarball installs:
 * - the first-party internal `buildKeyterms` resolves the peer through its real loader
 *   (identity, range and operation checks) and returns core's terms;
 * - the packed graph routes, both the shipped TypeScript source and the
 *   compiled default JavaScript, serve populated results through the peer;
 * - no published ui-server declaration names `@schlessera/brain`, so a
 *   consumer that does not install the optional peer can still typecheck it.
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const flag = process.argv.indexOf("--root");
if (flag === -1 || !process.argv[flag + 1]) throw new Error("check-ui-server-query-package requires --root <consumer install>");
const consumer = resolve(process.argv[flag + 1]);
const server = join(consumer, "node_modules/@schlessera/brain-ui-server");
const probeDir = mkdtempSync(join(consumer, ".ui-server-query-package-probe-"));
const brainPath = mkdtempSync(join(tmpdir(), "ui-server-query-package-"));
const env: Record<string, string | undefined> = { ...process.env, BRAIN_ROOT: brainPath };
for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "TYPESAFE_API_KEY", "BRAIN_RERANK_MODE"]) delete env[name];

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], { cwd: consumer, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Packed ui-server query probe failed: ${err}`);
  if (out.trim()) console.log(out.trim());
}

function declarations(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return declarations(path);
    return path.endsWith(".d.ts") ? [path] : [];
  });
}

try {
  // Policy is required host data, even when the optional query peer is absent.
  // Use a fresh process and the installed packages; workspace resolution must
  // not hide an eager import or a second copy of the policy implementation.
  const corePeer = join(consumer, "node_modules/@schlessera/brain");
  const heldCorePeer = join(probeDir, "held-core-peer");
  const policyProbe = join(probeDir, "policy-without-core.ts");
  await Bun.write(policyProbe, `
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
let peerPresent = false;
try { createRequire(import.meta.url).resolve("@schlessera/brain/package.json"); peerPresent = true; } catch {}
if (peerPresent) throw new Error("POLICY_OPTIONAL_CORE_ABSENT: fixture still resolves core");
await import("@schlessera/brain-ui-server");
const brainPath = ${JSON.stringify(brainPath)};
mkdirSync(brainPath + "/context/policies", { recursive: true });
for (const path of ${JSON.stringify([join(server, "src/brain/governance-policy.ts"), join(server, "dist/brain/governance-policy.js")])}) {
  const { createGovernancePolicyReader } = await import(path);
  const reader = createGovernancePolicyReader(brainPath);
  writeFileSync(brainPath + "/context/policies/governance.md", "---\\nschema_version: 1\\nprofiles:\\n  interactive: strict\\n---\\n");
  const valid = reader.load();
  if (valid.source !== "policy" || valid.policy.profiles.interactive !== "strict" || !valid.hash) throw new Error("POLICY_OPTIONAL_CORE_VALID_READ");
  writeFileSync(brainPath + "/context/policies/governance.md", "---\\nschema_version: 2\\n---\\n");
  const invalid = reader.load();
  if (invalid.source !== "last_valid" || invalid.hash !== valid.hash || !invalid.errors.length || invalid.policy.profiles.interactive !== "strict") throw new Error("POLICY_OPTIONAL_CORE_LAST_VALID");
}
console.log("packed ui-server: source/default policy reads and last-valid fallback work without core");
`);
  renameSync(corePeer, heldCorePeer);
  try { await run([policyProbe]); }
  finally { renameSync(heldCorePeer, corePeer); }

  // 1. Declarations: no reference to the optional peer, value or type.
  // A module reference — import/export from, import(), require() or a types
  // reference — not a string constant naming the package.
  const reference = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|<reference\s+types\s*=\s*|^\s*import\s+)["']@schlessera\/brain(?:\/[^"']*)?["']/m;
  const leaks = declarations(join(server, "dist")).filter((path) => reference.test(readFileSync(path, "utf8")));
  if (!reference.test('import type { GraphMeta } from "@schlessera/brain/queries";')) throw new Error("declaration reference pattern is broken");
  if (leaks.length) throw new Error(`Published ui-server declarations reference the optional core peer: ${leaks.join(", ")}`);
  console.log("ui-server declarations: no optional-peer reference");

  // 2. A CLI-produced Odysseus index.
  mkdirSync(join(brainPath, "notes"));
  await Bun.write(join(brainPath, "brain.config.json"), JSON.stringify({ profile: { name: "Odysseus" } }));
  for (const [name, body] of [["odysseus", "Sails for [[ithaca]] and [[Unknown Harbour]]."], ["ithaca", "Home; [[odysseus]] returns."]]) {
    await Bun.write(join(brainPath, `notes/${name}.md`), `---\ntitle: ${name === "odysseus" ? "Odysseus" : "Ithaca"}\ntype: note\nstatus: active\nrelevance: primary\ncreated: 2026-07-01\nupdated: 2026-07-12\ntags: [Ithaca]\n---\n${body}\n`);
  }
  await run([join(consumer, "node_modules/.bin/brain"), "index", "--force", "--json"]);

  const probe = join(probeDir, "probe.ts");
  const routesFor = (variant: "src" | "dist") => join(server, variant, "routes", variant === "src" ? "graph.ts" : "graph.js");
  await Bun.write(probe, `
import { buildKeyterms } from "@schlessera/brain-ui-server/internal";
const brainPath = ${JSON.stringify(brainPath)};
const cache = buildKeyterms({ brainPath, cacheDir: brainPath + "/.brain-ui", limit: 50 });
if (cache.degraded || !cache.keyterms.includes("Ithaca")) throw new Error("Packed keyterms did not come from core: " + JSON.stringify(cache));
for (const variant of ["src", "dist"]) {
  const { createGraphRoutes } = await import(variant === "src" ? ${JSON.stringify(routesFor("src"))} : ${JSON.stringify(routesFor("dist"))});
  const routes = createGraphRoutes({ brainRoot: brainPath });
  const meta = await (await routes.request("/graph/meta")).json();
  if (!meta.available || meta.nodeCount !== 2 || meta.edgeCount !== 2) throw new Error(variant + " packed graph meta: " + JSON.stringify(meta));
  const hood = await routes.request("/graph/neighborhood?center=notes/odysseus.md");
  const body = await hood.json();
  if (hood.status !== 200 || body.nodes.length !== 2) throw new Error(variant + " packed neighborhood: " + JSON.stringify(body));
  const broken = await (await routes.request("/graph/maintenance")).json();
  if (!broken.brokenLinks.some((l) => l.target === "Unknown Harbour")) throw new Error(variant + " packed maintenance: " + JSON.stringify(broken));
}
console.log("packed ui-server: keyterms and source/default graph routes read through the core peer");
`);
  await run([probe]);
} finally {
  rmSync(probeDir, { recursive: true, force: true });
  rmSync(brainPath, { recursive: true, force: true });
}
