/**
 * The `module` line of `brain --help` comes from the core command table and
 * `moduleCommand.summary`. Both must name every subcommand the command's own
 * help block documents, so a subcommand added later cannot leave the summary
 * describing only the first two (#4693).
 */
import { expect, test } from "bun:test";

import { CORE_COMMANDS } from "../src/cli/commands/index";
import { moduleCommand } from "../src/cli/commands/module";

/** The subcommands in the help block's usage line: `brain module <list|lint|…>`. */
function documentedSubcommands(): string[] {
  const usage = moduleCommand.helpBlock?.split("\n")[0] ?? "";
  const match = usage.match(/^brain module <([a-z|]+)>/);
  expect(match).not.toBeNull();
  return match![1]!.split("|");
}

/** The stem a summary uses for a subcommand: "list" → "list", "enable" → "enabl", "settings" → "setting". */
function stem(subcommand: string): string {
  return subcommand.replace(/e$|s$/, "");
}

test("the module summary names every subcommand the help block documents", () => {
  const subcommands = documentedSubcommands();
  expect(subcommands.sort()).toEqual(["disable", "enable", "lint", "list", "settings"]);
  for (const summary of [moduleCommand.summary, CORE_COMMANDS.module!.summary]) {
    const missing = subcommands.filter((sub) => !summary.toLowerCase().includes(stem(sub)));
    expect({ summary, missing }).toEqual({ summary, missing: [] });
  }
  expect(CORE_COMMANDS.module!.summary).toBe(moduleCommand.summary);
});
