import type { CommandModule } from "@schlessera/brain";
import type { DiagramsConfig } from "./module.js";

const HELP = "brain diagram --help\n\nDiagram module scaffold. Diagram checking and rendering are not available yet.";
const command: CommandModule<DiagramsConfig> = {
  summary: "Show diagram module help",
  helpBlock: HELP,
  async run(argv) {
    if (argv.length === 0 || (argv.length === 1 && argv[0] === "--help")) {
      console.log(HELP);
      return 0;
    }
    console.error(`Unknown diagram command.\n${HELP}`);
    return 1;
  },
};
export default command;
