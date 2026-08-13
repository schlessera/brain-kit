/**
 * Core command table. Each entry maps a top-level command word to its
 * implementation. Order here is the canonical order used in `brain --help`
 * before the module commands (which are appended, sorted).
 */

import type { CoreCommand } from "../types.js";

import { searchCommand } from "./search.js";
import { contextCommand } from "./context.js";
import { readCommand } from "./read.js";
import { listCommand } from "./list.js";
import { briefingCommand } from "./briefing.js";
import { addCommand } from "./add.js";
import { indexCommand } from "./index-cmd.js";
import { validateCommand } from "./validate.js";
import { auditCommand } from "./audit.js";
import { processCommand } from "./process.js";
import { archiveCommand } from "./archive.js";
import { acceptMtimeCommand } from "./accept-mtime.js";
import { maintainCommand } from "./maintain.js";
import { statsCommand } from "./stats.js";
import { graphCommand } from "./graph.js";
import { syncCommand } from "./sync.js";
import { setupCommand } from "./setup.js";
import { doctorCommand } from "./doctor.js";
import { initCommand } from "./init.js";
import { importCommand } from "./import.js";
import { skillsCommand } from "./skills.js";
import { moduleCommand } from "./module.js";
import { configCommand } from "./config.js";
import { mcpCommand } from "./mcp.js";
import { okfCommand } from "./okf.js";

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
  graph: graphCommand,
  sync: syncCommand,
  setup: setupCommand,
  doctor: doctorCommand,
  init: initCommand,
  import: importCommand,
  skills: skillsCommand,
  module: moduleCommand,
  config: configCommand,
  mcp: mcpCommand,
  okf: okfCommand,
};

export { generateBriefing } from "./briefing.js";
