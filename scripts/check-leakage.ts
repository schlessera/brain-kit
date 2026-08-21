// Personal-string leakage gate.
//
// This repo publishes; the brain it manages is personal. The hard rule in
// AGENTS.md — no real names, client names, or personal infrastructure anywhere
// in the tree — is enforced here, over the WHOLE working tree, untracked files
// included. The only exemption is a file named LICENSE, which must name the
// copyright holder. Do not add directory exemptions: the ones that used to
// exist (plan/, research/, PROGRESS.md) were dropped at the public cut
// precisely so this gate has nowhere to look away.
//
// This started life as inline shell in ci.yml; it moved here unchanged so it
// can be run locally (`bun run lint`), tested (tests/leakage-gate.test.ts),
// and read. Same patterns, same tree coverage, same no-exemptions policy.
//
// Every pattern is assembled from split string literals so this file — and
// the workflow and test that reference it — never trips the gate itself.
// Keep that trick when editing: a pattern stored whole is a finding.
//
//   bun scripts/check-leakage.ts [root]

import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

// The second alternative allows the public account name ending in "a" — it IS
// the brand now, and appears legitimately in every package name — while still
// catching the bare personal surname and the domain. `$` is end-of-line: the
// scan is per line, exactly like the grep -E it replaced.
const PATTERNS: string[] = [
  "al" + "ain",
  "schles" + "ser([^a]|$)",
  "car" + "ole",
  "buf" + "fy",
  "wyv" + "ern",
  // Personal infrastructure: deploy host and VPS address.
  "coo" + "lify-1",
  "91\\." + "99\\." + "200\\." + "114",
];

// Mirrors the old grep flags: --exclude-dir matched these basenames at any
// depth, --exclude=LICENSE matched the basename anywhere. `.git` is excluded
// whether it is the metadata DIRECTORY or a worktree gitlink FILE — both are
// git plumbing, and the file form holds an absolute local path that names the
// machine's user, which never exists in CI's fresh clone anyway.
const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist"]);
const EXCLUDED_FILES = new Set(["LICENSE", ".git"]);

export interface Finding {
  file: string;
  line: number;
  text: string;
}

export function leakagePattern(): RegExp {
  return new RegExp(PATTERNS.join("|"), "i");
}

export function scanText(file: string, text: string): Finding[] {
  const pattern = leakagePattern();
  const findings: Finding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      findings.push({ file, line: i + 1, text: lines[i].slice(0, 200) });
    }
  }
  return findings;
}

export function scanTree(root: string): Finding[] {
  const findings: Finding[] = [];
  const walk = (dir: string, relativeDir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) walk(full, relative);
        continue;
      }
      if (!entry.isFile() || EXCLUDED_FILES.has(entry.name)) continue;
      let text: string;
      try {
        // Lossy UTF-8 decode: binary files are scanned too, like grep, which
        // reported a bare "Binary file matches" — an ASCII personal string
        // inside one still surfaces here, with a line number.
        text = readFileSync(full).toString("utf-8");
      } catch {
        continue; // Unreadable in this checkout; CI's fresh clone has no such files.
      }
      findings.push(...scanText(relative, text));
    }
  };
  walk(root, "");
  return findings;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? process.cwd());
  const findings = scanTree(root);
  if (findings.length === 0) {
    console.log("Leakage gate clean.");
    process.exit(0);
  }
  console.error("Personal strings found outside allowed locations:");
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}: ${finding.text.trim()}`);
  }
  process.exit(1);
}
