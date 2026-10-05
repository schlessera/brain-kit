/**
 * The packed jobs module's hygiene check reads the content index through the
 * packed core's root-bound `ctx.queries`, in an installed consumer (#699, #700).
 *
 * Proves, against a CLI-produced index and the tarball installs, that the
 * packed `brain` CLI loads `@schlessera/brain-module-jobs` through its real
 * module loader under normal package resolution, and that `brain audit`
 * reports the module's complete stage-less opportunity selection: root and
 * nested `status.md` with the former ASCII case semantics, without near-names,
 * archived or staged opportunities.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";

const flag = process.argv.indexOf("--root");
if (flag === -1 || !process.argv[flag + 1]) throw new Error("check-module-query-package requires --root <consumer install>");
const consumer = resolve(process.argv[flag + 1]);
const brainPath = mkdtempSync(join(tmpdir(), "module-query-package-"));
const env: Record<string, string | undefined> = { ...process.env, BRAIN_ROOT: brainPath };
for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "TYPESAFE_API_KEY", "BRAIN_RERANK_MODE"]) delete env[name];

async function brain(args: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, join(consumer, "node_modules/.bin/brain"), ...args], { cwd: brainPath, env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`Packed module query probe failed: brain ${args.join(" ")}: ${err}`);
  return out;
}

const opportunity = (title: string, status: string, stage?: string) =>
  `---\ntype: opportunity\ntitle: "${title}"\ncreated: 2026-07-01\nupdated: 2026-07-12\nstatus: ${status}\nrelevance: primary\n${stage ? `stage: ${stage}\n` : ""}---\n\n## Overview\n`;

try {
  // The brain's config loads its modules from the consumer's installation.
  symlinkSync(join(consumer, "node_modules"), join(brainPath, "node_modules"));
  const files: Record<string, string> = {
    "brain.config.json": JSON.stringify({ profile: { name: "Odysseus" }, modules: { "@schlessera/brain-module-jobs": { criteria: "criteria.md" } } }),
    "criteria.md": "# Criteria\n\nA berth on a ship bound for Ithaca.\n",
    "status.md": opportunity("Return to Ithaca", "active"),
    "career/aeolus/status.md": opportunity("Aeolus — Wind Logistics", "active"),
    "career/circe/STATUS.md": opportunity("Circe — Island Operations", "active"),
    "career/ithaca/status.md": opportunity("Ithaca — Steward", "active", "applied"),
    "career/cyclops/status.md": opportunity("Cyclops — Shepherd", "archived"),
    "career/sirens/notstatus.md": opportunity("Sirens — Outreach", "active"),
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(brainPath, path)), { recursive: true });
    await Bun.write(join(brainPath, path), body);
  }
  await brain(["index", "--force", "--json"]);

  const listed = JSON.parse(await brain(["module", "list", "--json"])) as { enabled: { name: string }[] };
  if (!listed.enabled.some((m) => m.name === "jobs")) throw new Error("Packed jobs module did not load");

  const audit = JSON.parse(await brain(["audit", "--json"])) as { issues: { category: string; path: string; message: string }[] };
  const failures = audit.issues.filter((i) => i.category === "module-hygiene");
  if (failures.length) throw new Error(`Packed jobs hygiene check failed: ${failures.map((i) => i.message).join("; ")}`);
  const flagged = audit.issues.filter((i) => i.category === "jobs-stage").map((i) => i.path);
  const expected = ["career/aeolus/status.md", "career/circe/STATUS.md", "status.md"];
  if (JSON.stringify(flagged) !== JSON.stringify(expected)) {
    throw new Error(`Packed jobs hygiene selection ${JSON.stringify(flagged)} is not ${JSON.stringify(expected)}`);
  }
  console.log("packed jobs hygiene: complete selection through the packed core loader and queries");
} finally {
  rmSync(brainPath, { recursive: true, force: true });
}
