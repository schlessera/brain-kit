/**
 * The repo-local skills tell an unattended agent which commands to run. A
 * command that does not exist, a flag the script never reads, or a prefix that
 * switches output compression off costs every run that follows the skill.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const skillFiles = [...new Bun.Glob(".agents/skills/**/*.md").scanSync({ cwd: ROOT, dot: true })].sort();
const TRACKER_SKILLS = [".agents/skills/work-issue/SKILL.md", ".agents/skills/work-issue/references/ci-and-merge.md", ".agents/skills/triage-issues/SKILL.md"];

/** Invocations of one script in a document: the subcommand, if any, and the flags on that line. */
function invocations(text: string, script: string): Array<{ sub: string | undefined; flags: string[]; line: string }> {
  const pattern = new RegExp(`bun scripts/${script.replace(".", "\\.")}(?: ([a-z]+))?([^\\n\`]*)`, "g");
  return [...text.matchAll(pattern)].map(match => ({ sub: match[1], flags: [...match[2]!.matchAll(/--([a-z][a-z-]*)/g)].map(flag => flag[1]!), line: match[0] }));
}

describe("how the skills write commands", () => {
  test("the skills are found", () => {
    expect(skillFiles).toEqual(expect.arrayContaining([...TRACKER_SKILLS, ".agents/skills/test-health/SKILL.md", ".agents/skills/test-health-push/SKILL.md"]));
  });

  test("no command is prefixed with rtk's passthrough, which would switch its compression off", () => {
    const prefixed = skillFiles.flatMap(file => read(file).split("\n")
      .filter(line => /\brtk (?:proxy|bypass) [a-z"$]/.test(line.replaceAll("`rtk proxy` or `rtk bypass`", "")))
      .map(line => `${file}: ${line.trim()}`));
    expect(prefixed).toEqual([]);
  });

  test("the tracker skills leave pagination and filtering to the scripts, not to a shell pipeline through jq", () => {
    // `gh --jq` is gh's own filter and stays; the sentence that names the old pipeline is not one.
    const piped = TRACKER_SKILLS.flatMap(file => read(file).split("\n").filter(line => /\|\s*jq\b/.test(line.replaceAll("`gh ... | jq`", ""))).map(line => `${file}: ${line.trim()}`));
    expect(piped).toEqual([]);
    for (const file of [TRACKER_SKILLS[0]!, TRACKER_SKILLS[2]!]) expect(read(file), file).not.toMatch(/\bBun,? git and `jq`|and `jq`\./);
  });
});

describe("the tracker commands the skills name", () => {
  const queue = read("scripts/issue-queue.ts"), status = read("scripts/pr-status.ts");
  const text = TRACKER_SKILLS.map(read).join("\n") + read(".agents/skills/test-health/references/landing.md");
  const queued = invocations(text, "issue-queue.ts"), statused = invocations(text, "pr-status.ts");

  test("both scripts are invoked often enough for this check to mean something", () => {
    expect(queued.length).toBeGreaterThanOrEqual(12);
    expect(statused.length).toBeGreaterThanOrEqual(5);
  });

  test("every issue-queue subcommand is one the script dispatches", () => {
    const known = [...queue.matchAll(/command === "([a-z]+)"/g)].map(match => match[1]!);
    expect(known.sort()).toEqual(["candidates", "check", "claim", "labels", "release", "show", "snapshot"]);
    // A bare mention of the script in prose names no subcommand.
    expect(queued.filter(entry => entry.sub && !known.includes(entry.sub)).map(entry => entry.line)).toEqual([]);
    expect(new Set(queued.map(entry => entry.sub).filter(Boolean)).size).toBeGreaterThanOrEqual(6);
  });

  test("every flag written beside either script is one it reads", () => {
    const reads = (source: string) => new Set([...source.matchAll(/(?:text|flags\.has|flags\.get)\("([a-z-]+)"\)|\["([a-z-]+)", "([a-z-]+)"(?:, "([a-z-]+)")?\]\.includes\(arg|new Set\(\[([^\]]+)\]\)/g)]
      .flatMap(match => match[5] ? [...match[5].matchAll(/"([a-z-]+)"/g)].map(flag => flag[1]!) : match.slice(1, 5).filter((flag): flag is string => Boolean(flag))));
    const unread = [
      ...queued.flatMap(entry => entry.flags.filter(flag => !reads(queue).has(flag)).map(flag => `issue-queue --${flag}: ${entry.line}`)),
      ...statused.flatMap(entry => entry.flags.filter(flag => !reads(status).has(flag)).map(flag => `pr-status --${flag}: ${entry.line}`)),
    ];
    expect(unread).toEqual([]);
  });
});
