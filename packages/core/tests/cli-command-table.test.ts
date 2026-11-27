/**
 * The lazy core command table (#4793): the same 39 words in the same order as
 * before, and each row's summary is the summary of the command it loads, so
 * `brain --help` (which reads the table) and `brain <cmd>` (which loads the
 * command) can never disagree.
 */
import { expect, test } from "bun:test";
import { CORE_COMMANDS } from "../src/cli/commands/index.js";
import { CORE_COMMAND_WORDS } from "./helpers/core-command-words";

test("the core command table holds the 39 command words in their order on main", () => {
  expect(CORE_COMMAND_WORDS).toHaveLength(39);
  expect(Object.keys(CORE_COMMANDS)).toEqual(CORE_COMMAND_WORDS);
});

test("each row's summary equals the summary of the command its load returns", async () => {
  for (const [word, entry] of Object.entries(CORE_COMMANDS)) {
    const command = await entry.load();
    expect(typeof command.run, word).toBe("function");
    expect(entry.summary, word).toBe(command.summary);
  }
}, 60_000);
