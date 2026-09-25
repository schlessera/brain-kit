/**
 * The jobs skills write wherever `opportunitiesDir` points, not to the
 * default: every path goes through a placeholder resolved from
 * `brain config check --json` before the first write.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SKILLS = ["research-opportunity", "interview-scheduled"];
const read = (skill: string) => readFileSync(join(import.meta.dir, "../skills", skill, "SKILL.md"), "utf-8");

describe.each(SKILLS)("%s", (skill) => {
  test("names career/opportunities only in the sentence about the default", () => {
    const sentences = read(skill)
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => sentence.includes("career/opportunities"));
    expect(sentences).toHaveLength(1);
    expect(sentences[0]).toMatch(/default/);
  });

  test("looks the directory up with brain config check --json before any path uses it", () => {
    const text = read(skill);
    const lookup = text.indexOf("brain config check --json");
    expect(lookup).toBeGreaterThan(-1);
    expect(text).toContain("taxonomy.types.opportunity.dir");
    const firstPath = text.indexOf("{opportunities}/");
    expect(firstPath).toBeGreaterThan(lookup);
  });
});
