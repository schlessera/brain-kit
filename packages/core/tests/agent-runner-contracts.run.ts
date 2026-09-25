/**
 * The built-in agent runners through the published AgentRunner contract suite
 * (`@schlessera/brain/testing`, #342). Not a `*.test.ts` file: it only means
 * something under the environment agent-runner-contracts.test.ts starts it
 * with — a `PATH` holding nothing but stand-in agent CLIs, `CLAUDE_CODE_PATH`
 * naming the stand-in claude, and `BRAIN_CONTRACT_AGENT_MODE` naming the file
 * that says whether the stand-ins answer or hang.
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";

import { runAgentRunnerContract } from "@schlessera/brain/testing";

import { AGENT_RUNNERS } from "../src/lib/registry";

const modeFile = process.env.BRAIN_CONTRACT_AGENT_MODE;
if (!modeFile) throw new Error("run through agent-runner-contracts.test.ts, not directly");

for (const [name, factory] of Object.entries(AGENT_RUNNERS)) {
  runAgentRunnerContract(
    {
      name,
      echoing() {
        writeFileSync(modeFile, "echo");
        return factory();
      },
      hanging() {
        writeFileSync(modeFile, "hang");
        return factory();
      },
    },
    { describe, expect, test }
  );
}
