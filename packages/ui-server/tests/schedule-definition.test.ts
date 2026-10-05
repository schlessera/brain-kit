import { expect, test } from "bun:test";
import { z } from "zod";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, parseStrictJson, scheduleFingerprint } from "../src/schedules/canonical.js";
import {
  materializeDefinition,
  normalizeDefinitionInput,
  parseDefinitionFile,
  SCHEDULE_TOOLS,
  serializeDefinition,
} from "../src/schedules/definition.js";
import { cronDefinition } from "./helpers/schedule-fixture.js";

const NOW = Date.parse("2026-07-12T06:00:00Z");

function stored() {
  return materializeDefinition(normalizeDefinitionInput(cronDefinition()), { id: "task_ithaca_review", now: NOW }).definition;
}

test("the scheduled brain_read schema is the registered core tool's input schema", () => {
  // mcp-input-schemas.json pins the live core MCP server's advertised input
  // schemas (packages/core/tests/mcp-contract.test.ts), so this chains to it.
  const pinned = JSON.parse(readFileSync(join(import.meta.dir, "../../core/tests/mcp-input-schemas.json"), "utf8")).brain_read;
  const { additionalProperties, ...host } = z.toJSONSchema(SCHEDULE_TOOLS.brain_read!.inputs, { target: "draft-7" }) as Record<string, unknown>;
  expect(additionalProperties).toBe(false);
  expect(host).toEqual(pinned);
});

test("definition files round-trip exactly and carry no authority", () => {
  const definition = stored();
  const text = serializeDefinition(definition);
  expect(text).toBe([
    "---",
    "schedule_schema: 1",
    'id: "task_ithaca_review"',
    'when: {"cron":"0 7 * * 1-5","endAt":null,"kind":"cron","timeZone":"Europe/Athens"}',
    'scope: {"egress":[],"operation":"Report outstanding Ithaca checks","targets":["notes/ithaca.md"],"tools":[{"inputs":{"path":"notes/ithaca.md"},"name":"brain_read"}],"variableInputs":[]}',
    'limits: {"attemptTimeoutMs":600000,"maxOperations":3}',
    "notifyOnSuccess: false",
    "---",
    "Read notes/ithaca.md and report outstanding checks. Do not change files or use network tools.",
  ].join("\n"));
  expect(parseDefinitionFile(text)).toEqual(definition);
});

test("strict parsing refuses duplicate, unknown, typed or non-canonical frontmatter", () => {
  const text = serializeDefinition(stored());
  const variants: Record<string, string> = {
    duplicate: text.replace("notifyOnSuccess: false", "notifyOnSuccess: false\nnotifyOnSuccess: true"),
    unknown: text.replace("notifyOnSuccess: false", "notifyOnSuccess: false\ncreator: principal_x"),
    missing: text.replace("notifyOnSuccess: false\n", ""),
    yamlDate: text.replace('id: "task_ithaca_review"', "id: 2026-07-12"),
    yamlBinary: text.replace("notifyOnSuccess: false", "notifyOnSuccess: !!binary aGVsbG8="),
    reformatted: text.replace('limits: {"attemptTimeoutMs":600000,"maxOperations":3}', "limits:\n  attemptTimeoutMs: 600000\n  maxOperations: 3"),
    widened: text.replace("600000", "900000"),
    unsupportedTool: text.replace('"name":"brain_read"', '"name":"Bash"'),
    nul: text.replace("Read notes", "Read\u0000notes"),
    schema: text.replace("schedule_schema: 1", "schedule_schema: 2"),
  };
  for (const [name, variant] of Object.entries(variants)) expect({ name, ok: (() => { try { parseDefinitionFile(variant); return true; } catch { return false; } })() }).toEqual({ name, ok: false });
});

test("fingerprints bind definition, root, creator and execution policy", () => {
  const definition = stored();
  const subject = { definition, rootIdentity: "root_a", creatorPrincipalId: "p1", executionPolicy: { backendId: "b", profileId: null, inferenceOrigins: [] } };
  const base = scheduleFingerprint(subject);
  expect(base).toMatch(/^[0-9a-f]{64}$/);
  expect(scheduleFingerprint({ ...subject, rootIdentity: "root_b" })).not.toBe(base);
  expect(scheduleFingerprint({ ...subject, creatorPrincipalId: "p2" })).not.toBe(base);
  expect(scheduleFingerprint({ ...subject, executionPolicy: { ...subject.executionPolicy, profileId: "x" } })).not.toBe(base);
  expect(scheduleFingerprint({ ...subject, definition: { ...definition, prompt: `${definition.prompt} ` } })).not.toBe(base);
  // Key order and negative zero never change the canonical form.
  expect(canonicalJson({ b: 1, a: -0 })).toBe('{"a":0,"b":1}');
});

test("CRLF normalizes once at proposal time and control characters are refused", () => {
  const input = normalizeDefinitionInput({ ...cronDefinition(), prompt: "Line one\r\nLine two\tend" });
  expect(input.prompt).toBe("Line one\nLine two\tend");
  for (const prompt of ["   ", "bell\u0007", "Read Ithaca\ud800", "x".repeat(16 * 1024 + 1)]) {
    expect(() => normalizeDefinitionInput({ ...cronDefinition(), prompt })).toThrow();
  }
});

test("strict request JSON rejects duplicate keys, deep nesting and non-finite numbers", () => {
  expect(parseStrictJson('{"a":1,"b":[1,{"c":"d"}]}')).toEqual({ a: 1, b: [1, { c: "d" }] });
  for (const bad of ['{"a":1,"a":2}', '{"a":{"b":1,"b":2}}', "[1e400]", "{", '{"a":1}x', `${"[".repeat(40)}${"]".repeat(40)}`]) {
    expect(() => parseStrictJson(bad)).toThrow();
  }
});
