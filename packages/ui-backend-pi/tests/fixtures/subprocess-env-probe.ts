import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";

import { createBrainAccess } from "../../src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../../src/tools";
import { createTurnContext } from "../../src/turn-context";
import { resultText } from "../helpers";

const root = process.argv[2];
if (!root) throw new Error("probe root argument is required");

const tools = Object.fromEntries(
  createBrainTools({
    brain: createBrainAccess(root),
    turn: createTurnContext(),
    lock: toolLockFromKeyed(createKeyedLock()),
  }).map((tool) => [tool.name, tool])
);
const ctx = {} as never;
const grep = await tools.grep.execute(
  "grep-env",
  { pattern: "unused" },
  undefined,
  undefined,
  ctx
);
const bash = await tools.bash.execute(
  "bash-env",
  {
    command:
      'printf "%s|%s|%s|%s" "${COOKIE_SECRET-unset}" "$CLAUDE_CODE_OAUTH_TOKEN" "$GITHUB_TOKEN" "$BRAIN_UI_SYNC_GITHUB_TOKEN"',
  },
  undefined,
  undefined,
  ctx
);

console.log(JSON.stringify({ grep: resultText(grep), bash: resultText(bash) }));
