/**
 * The leakage gate's own teeth (scripts/check-leakage.ts).
 *
 * Every fixture string is constructed at runtime from pieces — never stored
 * whole — because the repo-wide scan below covers this file too, and a raw
 * fixture would be a real finding. That is the same trick the detector itself
 * uses to avoid matching its own pattern table.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "path";

import { scanText, scanTree } from "../scripts/check-leakage";

const FIRST_NAME = ["al", "ain"].join("");
const SURNAME = ["schles", "ser"].join("");
const BRAND = SURNAME + "a"; // the public account name — deliberately allowed
const DEPLOY_HOST = ["coo", "lify-1"].join("");
const VPS_IP = ["91", "99", "200", "114"].join(".");

describe("scanText", () => {
  test("flags the personal first name, case-insensitively", () => {
    expect(scanText("a.md", `by ${FIRST_NAME}\n`)).toHaveLength(1);
    const upper = FIRST_NAME.toUpperCase();
    expect(scanText("a.md", `by ${upper}\n`)).toHaveLength(1);
  });

  test("flags the bare surname but allows the brand ending in 'a'", () => {
    // Mid-line, followed by a non-'a' character.
    expect(scanText("a.md", `${SURNAME} wrote this\n`)).toHaveLength(1);
    // End of line — the `$` alternative.
    expect(scanText("a.md", `written by ${SURNAME}\n`)).toHaveLength(1);
    // The npm account name IS the brand and appears in every package name.
    expect(scanText("a.md", `install @${BRAND}/brain\n`)).toEqual([]);
  });

  test("flags personal infrastructure: deploy host and VPS address", () => {
    expect(scanText("a.yml", `host: ${DEPLOY_HOST}\n`)).toHaveLength(1);
    expect(scanText("a.yml", `addr: ${VPS_IP}\n`)).toHaveLength(1);
    // The IP pattern has escaped dots: a different address that a bare-dot
    // regex would wrongly match must stay quiet.
    expect(scanText("a.yml", `addr: ${["91x", "99x", "200x", "114"].join("")}\n`)).toEqual([]);
  });

  test("reports the line the string is on", () => {
    const findings = scanText("a.md", `clean\nclean\n${FIRST_NAME} here\n`);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.line).toBe(3);
  });

  test("ordinary content is quiet", () => {
    expect(scanText("a.ts", 'const brain = "knowledge";\nexport default brain;\n')).toEqual([]);
  });
});

describe("repository", () => {
  test("the whole tree is free of personal strings", () => {
    const findings = scanTree(resolve(import.meta.dir, ".."));
    const report = findings.map((f) => `${f.file}:${f.line}`).join("\n");
    expect(report).toBe("");
  });
});
