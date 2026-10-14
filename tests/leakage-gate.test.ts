/**
 * The leakage gate's own teeth (scripts/check-leakage.ts).
 *
 * Every fixture string is constructed at runtime from pieces — never stored
 * whole — because the repo-wide scan below covers this file too, and a raw
 * fixture would be a real finding. That is the same trick the detector itself
 * uses to avoid matching its own pattern table.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

import { scanText, scanTree } from "../scripts/check-leakage";

const FIRST_NAME = ["al", "ain"].join("");
const SURNAME = ["schles", "ser"].join("");
const UPLOAD_HOST = `uploads.${SURNAME}.net`;
const UPLOAD_IMAGE = `https://${UPLOAD_HOST}/gh/design.png`;
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

  test("allows upload image URLs only when tracker screening opts in", () => {
    const body = `![Design](${UPLOAD_IMAGE})`;
    expect(scanText("body", body, { allowUploadImages: true })).toEqual([]);
    expect(scanText("body", body)).toHaveLength(1);
    expect(scanText("body", body, { allowUploadImages: false })).toHaveLength(1);
  });

  test("still scans text outside an allowed upload image URL", () => {
    const body = `clean\n![Design](${UPLOAD_IMAGE}) by ${SURNAME}`;
    expect(scanText("body", body, { allowUploadImages: true })).toEqual([
      { file: "body", line: 2, text: body.split("\n")[1]! },
    ]);
    expect(scanText("body", `![${FIRST_NAME}](${UPLOAD_IMAGE})`, {
      allowUploadImages: true,
    })).toHaveLength(1);
  });

  test("does not exempt other hosts, paths or non-HTTPS URLs", () => {
    const refused = [
      `http://${UPLOAD_HOST}/gh/design.png`,
      `https://${UPLOAD_HOST}/other/design.png`,
      `https://${UPLOAD_HOST}/gh-other/design.png`,
      `https://${UPLOAD_HOST}/gh`,
      `https://${UPLOAD_HOST}/gh/../private/design.png`,
      `https://${UPLOAD_HOST}.example.org/gh/design.png`,
      `https://other.${SURNAME}.net/gh/design.png`,
      `https://user@${UPLOAD_HOST}/gh/design.png`,
      `https://${UPLOAD_HOST}:8443/gh/design.png`,
      `//${UPLOAD_HOST}/gh/design.png`,
      `https://example.org/?image=${UPLOAD_IMAGE}`,
    ];
    for (const url of refused) {
      expect(scanText("body", `![Design](${url})`, { allowUploadImages: true }))
        .toHaveLength(1);
    }
  });

  test("ordinary content is quiet", () => {
    expect(scanText("a.ts", 'const brain = "knowledge";\nexport default brain;\n')).toEqual([]);
  });
});

describe("repository", () => {
  test("tree and CLI scans reject upload image URLs", () => {
    const root = mkdtempSync(join(tmpdir(), "leakage-upload-"));
    try {
      writeFileSync(join(root, "image.md"), UPLOAD_IMAGE);
      expect(scanTree(root)).toEqual([
        { file: "image.md", line: 1, text: UPLOAD_IMAGE },
      ]);
      const child = Bun.spawnSync({
        cmd: [process.execPath, resolve(import.meta.dir, "../scripts/check-leakage.ts"), root],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toContain("image.md:1:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the whole tree is free of personal strings", () => {
    const findings = scanTree(resolve(import.meta.dir, ".."));
    const report = findings.map((f) => `${f.file}:${f.line}`).join("\n");
    expect(report).toBe("");
  });
});
