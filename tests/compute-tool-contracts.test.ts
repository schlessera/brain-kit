/**
 * The hosted compute bridge tools (#3108) take exactly core's operation
 * inputs: the same strict JSON Schema, so a hosted call and `brain compute`
 * are the same request, and no caller, session, profile or credential field
 * exists on either. The six names match core's MCP tools, and the in-worker
 * copies are disallowed in every Claude session.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { COMPUTE_TOOL_NAMES, computeHealthInput, computeJobInput, computeRequestInput } from "../packages/core/src/lib/ops/compute.js";
import {
  COMPUTE_HEALTH_INPUT_SCHEMA,
  COMPUTE_JOB_INPUT_SCHEMA,
  COMPUTE_REQUEST_INPUT_SCHEMA,
  COMPUTE_TOOL_CONTRACTS,
} from "../packages/ui-sdk/src/tool-contracts/compute.js";
import { IN_WORKER_COMPUTE_TOOLS } from "../packages/ui-backend-claude/src/sdk-options.js";

const schema = (input: z.ZodType) => z.toJSONSchema(input, { io: "input" });

describe("hosted compute tool contracts", () => {
  test("each input's JSON Schema is identical to core's operation input", () => {
    expect(schema(COMPUTE_HEALTH_INPUT_SCHEMA), "HEALTH_SCHEMA_EQUALS_CORE").toEqual(schema(computeHealthInput));
    expect(schema(COMPUTE_REQUEST_INPUT_SCHEMA), "REQUEST_SCHEMA_EQUALS_CORE").toEqual(schema(computeRequestInput));
    expect(schema(COMPUTE_JOB_INPUT_SCHEMA), "JOB_SCHEMA_EQUALS_CORE").toEqual(schema(computeJobInput));
  });

  test("every input refuses an extra key, so a forged caller field cannot ride along", () => {
    for (const contract of COMPUTE_TOOL_CONTRACTS) {
      expect((schema(contract.input) as { additionalProperties?: unknown }).additionalProperties, contract.name).toBe(false);
    }
    expect(COMPUTE_REQUEST_INPUT_SCHEMA.safeParse({ provider: "boat-small", argv: ["true"], principal: "penelope" }).success).toBe(false);
    expect(COMPUTE_JOB_INPUT_SCHEMA.safeParse({ job: "cj_ithaca", session: "s-other" }).success).toBe(false);
  });

  test("the names are core's MCP tool names, and every in-worker copy is disallowed", () => {
    expect(COMPUTE_TOOL_CONTRACTS.map(contract => contract.name)).toEqual([...COMPUTE_TOOL_NAMES]);
    expect(IN_WORKER_COMPUTE_TOOLS).toEqual(COMPUTE_TOOL_NAMES.map(name => `mcp__brain__${name}`));
  });
});
