/**
 * Core command table. Each entry maps a top-level command word to its
 * implementation. Order here is the canonical order used in `brain --help`
 * before the module commands (which are appended, sorted).
 */

import type { CoreCommand } from "../types";

import { searchCommand } from "./search";
import { contextCommand } from "./context";
import { readCommand } from "./read";
import { listCommand } from "./list";
import { briefingCommand } from "./briefing";
import { addCommand } from "./add";
import { indexCommand } from "./index-cmd";
import { validateCommand } from "./validate";
import { auditCommand } from "./audit";
import { processCommand } from "./process";
import { archiveCommand } from "./archive";
import { acceptMtimeCommand } from "./accept-mtime";
import { maintainCommand } from "./maintain";
import { statsCommand } from "./stats";
import { syncCommand } from "./sync";
import { setupCommand } from "./setup";
import { doctorCommand } from "./doctor";
import { initCommand } from "./init";
import { importCommand } from "./import";
import { skillsCommand } from "./skills";
import { moduleCommand } from "./module";
import { configCommand } from "./config";
import { mcpCommand } from "./mcp";

export const CORE_COMMANDS: Record<string, CoreCommand> = {
  search: searchCommand,
  context: contextCommand,
  read: readCommand,
  list: listCommand,
  briefing: briefingCommand,
  add: addCommand,
  index: indexCommand,
  validate: validateCommand,
  audit: auditCommand,
  process: processCommand,
  archive: archiveCommand,
  "accept-mtime": acceptMtimeCommand,
  maintain: maintainCommand,
  stats: statsCommand,
  sync: syncCommand,
  setup: setupCommand,
  doctor: doctorCommand,
  init: initCommand,
  import: importCommand,
  skills: skillsCommand,
  module: moduleCommand,
  config: configCommand,
  mcp: mcpCommand,
};

export { generateBriefing } from "./briefing";
