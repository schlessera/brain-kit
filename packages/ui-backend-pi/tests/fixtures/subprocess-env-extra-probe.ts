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
const bash = await tools.bash.execute(
  "bash-extra-env",
  {
    command:
      'printf "%s|%s|%s|%s|%s" "$CUSTOM_OPERATOR_TOKEN" "${BRAIN_UI_SUBPROCESS_ENV_EXTRA-unset}" "${UNKNOWN_CHILD_VALUE-unset}" "$BRAVE_API_KEY" "${EXA_API_KEY-unset}"',
  },
  undefined,
  undefined,
  ctx
);

console.log(resultText(bash).split("\n").at(-1));
