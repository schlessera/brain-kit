import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScoringConfig, scoreJob, type ScoreJobInput } from "../src/score.js";

let directory: string, data: string, config: string;
let savedData: string | undefined, savedConfig: string | undefined;
const scoring = (weight: number) => ({ groups: [{ name: "voyages", weight, keywords: ["ithaca"] }] });
const job: ScoreJobInput = { title: "Voyages to Ithaca", company: "Ithaca", description_text: null,
  location: null, tags: null, salary_min: null, salary_max: null, remote_type: null };
beforeEach(() => {
  savedData = process.env.BRAIN_WORKER_DATA_ROOT; savedConfig = process.env.BRAIN_WORKER_CONFIG_ROOT;
  directory = mkdtempSync(join(tmpdir(), "jobs-worker-scoring-"));
  data = join(directory, "data"); config = join(directory, "config");
  for (const [root, weight] of [[data, 5], [config, 25]] as const) {
    mkdirSync(join(root, "settings"), { recursive: true });
    writeFileSync(join(root, "criteria.md"), `---\n${JSON.stringify({ scoring: scoring(weight) })}\n---\n# Voyages to Ithaca\n`);
  }
  process.env.BRAIN_WORKER_DATA_ROOT = data; process.env.BRAIN_WORKER_CONFIG_ROOT = config;
});
afterEach(() => {
  if (savedData === undefined) delete process.env.BRAIN_WORKER_DATA_ROOT; else process.env.BRAIN_WORKER_DATA_ROOT = savedData;
  if (savedConfig === undefined) delete process.env.BRAIN_WORKER_CONFIG_ROOT; else process.env.BRAIN_WORKER_CONFIG_ROOT = savedConfig;
  rmSync(directory, { recursive: true, force: true });
});

describe("hosted worker scoring", () => {
  test("criteria markdown scores from the frozen configuration root", () => {
    expect(scoreJob(job, loadScoringConfig(data, "criteria.md")).total).toBe(25);
  });

  test("jobs JSON scoring overrides come from the frozen configuration root", () => {
    writeFileSync(join(data, "settings/jobs.json"), JSON.stringify({ scoring: scoring(10) }));
    writeFileSync(join(config, "settings/jobs.json"), JSON.stringify({ scoring: scoring(40) }));
    expect(scoreJob(job, loadScoringConfig(data, "criteria.md")).total).toBe(40);
  });

  test("missing frozen JSON ignores data JSON and uses frozen criteria", () => {
    writeFileSync(join(data, "settings/jobs.json"), JSON.stringify({ scoring: scoring(10) }));
    expect(scoreJob(job, loadScoringConfig(data, "criteria.md")).total).toBe(25);
  });

  test("explicit scoring and ordinary roots retain their precedence", () => {
    expect(scoreJob(job, loadScoringConfig(data, "criteria.md", scoring(50))).total).toBe(50);
    delete process.env.BRAIN_WORKER_DATA_ROOT;
    expect(scoreJob(job, loadScoringConfig(data, "criteria.md")).total).toBe(5);
  });

});
