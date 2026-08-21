/**
 * Environment documentation generator (the G4 half of the env chokepoint).
 *
 * Each package that reads the environment declares every variable in its
 * `src/config/env.ts` descriptor. That descriptor is the source of truth; this
 * script renders it into the package README between the env markers, and
 * `tests/env-parity.test.ts` fails when the two disagree.
 *
 * The alternative — a hand-written list next to a hand-written descriptor —
 * is what produced `ui-server`'s README section listing `WEBAUTHN_*` and
 * `VOICE_*` as wildcards while the code read 31 distinct variables, with the
 * only real list living in a different repo.
 *
 *   bun scripts/env-docs.ts          # rewrite every README block
 *   bun scripts/env-docs.ts --check  # fail if any block is out of date
 */

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

// The descriptor contract, shared with every package's chokepoint through the
// sync-enforced `env-core.ts` copies (tests/env-core-sync.test.ts). This is a
// root script, not published code, so it may import the canonical copy
// directly instead of carrying its own redeclaration.
import type {
  DynamicEnvReadSpec,
  EnvVarSpec,
} from "../packages/core/src/config/env-core.ts";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");

export const BEGIN = "<!-- env:begin -->";
export const END = "<!-- env:end -->";

export interface PackageEnv {
  dir: string;
  envModule: string;
  readmePath: string;
  vars: readonly EnvVarSpec[];
  dynamic: readonly DynamicEnvReadSpec[];
}

/** Every package with an env chokepoint, in directory order. */
export function packagesWithEnv(): string[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((dir) => {
      try {
        readFileSync(join(PACKAGES_DIR, dir, "src", "config", "env.ts"));
        return true;
      } catch {
        return false;
      }
    })
    .sort();
}

export async function loadPackageEnv(dir: string): Promise<PackageEnv> {
  const envModule = join(PACKAGES_DIR, dir, "src", "config", "env.ts");
  const loaded = (await import(envModule)) as {
    ENV_VARS?: readonly EnvVarSpec[];
    DYNAMIC_ENV_READS?: readonly DynamicEnvReadSpec[];
  };
  if (!Array.isArray(loaded.ENV_VARS)) {
    throw new Error(`${dir}: src/config/env.ts must export ENV_VARS`);
  }
  return {
    dir,
    envModule,
    readmePath: join(PACKAGES_DIR, dir, "README.md"),
    vars: loaded.ENV_VARS,
    dynamic: loaded.DYNAMIC_ENV_READS ?? [],
  };
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function renderBlock(pkg: PackageEnv): string {
  const lines: string[] = [BEGIN, ""];
  if (pkg.vars.length === 0) {
    lines.push("This package reads no environment variables directly.", "");
  } else {
    lines.push(
      "| Variable | What it controls | Unset |",
      "| --- | --- | --- |"
    );
    for (const spec of [...pkg.vars].sort((a, b) => a.name.localeCompare(b.name))) {
      const unset =
        typeof spec.required === "string"
          ? `**required** \u2014 ${escapeCell(spec.required)}`
          : spec.required
            ? "**required**"
            : spec.default
              ? escapeCell(spec.default)
              : "\u2014";
      lines.push(`| \`${spec.name}\` | ${escapeCell(spec.description)} | ${unset} |`);
    }
    lines.push("");
  }
  if (pkg.dynamic.length > 0) {
    lines.push(
      "Reads whose variable *name* is configuration rather than code:",
      "",
      "| Name comes from | What the value is used for |",
      "| --- | --- |"
    );
    for (const spec of [...pkg.dynamic].sort((a, b) => a.source.localeCompare(b.source))) {
      // `source` is prose that may carry its own code spans, so it is not wrapped.
      lines.push(`| ${escapeCell(spec.source)} | ${escapeCell(spec.description)} |`);
    }
    lines.push("");
  }
  lines.push(
    `Generated from \`packages/${pkg.dir}/src/config/env.ts\` by ` +
      "`bun run env-docs`. Edit the descriptor, not this table.",
    END
  );
  return lines.join("\n");
}

/** The README with its env block replaced, or null when it has no block. */
export function applyBlock(readme: string, block: string): string | null {
  const begin = readme.indexOf(BEGIN);
  const end = readme.indexOf(END);
  if (begin === -1 || end === -1) return null;
  return readme.slice(0, begin) + block + readme.slice(end + END.length);
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const problems: string[] = [];
  let rewritten = 0;

  for (const dir of packagesWithEnv()) {
    const pkg = await loadPackageEnv(dir);
    let readme: string;
    try {
      readme = readFileSync(pkg.readmePath, "utf8");
    } catch {
      problems.push(`packages/${dir}/README.md is missing`);
      continue;
    }
    const updated = applyBlock(readme, renderBlock(pkg));
    if (updated === null) {
      problems.push(
        `packages/${dir}/README.md has no ${BEGIN} … ${END} block — ` +
          "add one under its Environment heading"
      );
      continue;
    }
    if (updated === readme) continue;
    if (check) {
      problems.push(`packages/${dir}/README.md env table is out of date`);
    } else {
      writeFileSync(pkg.readmePath, updated);
      rewritten++;
    }
  }

  if (problems.length > 0) {
    console.error("Environment documentation is out of sync:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("\nRun `bun run env-docs` to regenerate.");
    process.exit(1);
  }
  console.log(
    check
      ? "Environment documentation is in sync."
      : `Environment documentation regenerated (${rewritten} file(s) changed).`
  );
}
