import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createBrainAccess } from "../../src/brain-access";
import { createBrainTools, toolLockFromKeyed } from "../../src/tools";
import { createTurnContext } from "../../src/turn-context";
import { resultText } from "../helpers";
const root = process.argv[2]!;
const bash = createBrainTools({ brain: createBrainAccess(root), turn: createTurnContext(), lock: toolLockFromKeyed(createKeyedLock()) }).find(tool => tool.name === "bash")!;
const result = await bash.execute("rtk-warning", { command: "git status" }, undefined, undefined, {} as never);
console.log(resultText(result));
