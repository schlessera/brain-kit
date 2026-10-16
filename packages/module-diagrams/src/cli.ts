import { resolve } from "node:path";
import type { CommandModule } from "@schlessera/brain";
import type { DiagramsConfig } from "./module.js";
import { checkDiagram, type DiagramCheckResult } from "./check.js";

const HELP = "brain diagram check <file|-> [--json]\n\nValidate a standalone .diagram.yaml spec or one diagram fence. Use - for stdin.";
const command: CommandModule<DiagramsConfig> = {
  summary: "Validate a versioned diagram spec",
  helpBlock: HELP,
  async run(argv, context) {
    if (argv.length === 0 || (argv.length === 1 && argv[0] === "--help")) { console.log(HELP); return 0; }
    const json = !argv.includes("--human") && (context.json || argv.includes("--json")), args = argv.filter(arg => arg !== "--json" && arg !== "--human");
    let checked: DiagramCheckResult;
    if (args.length !== 2 || args[0] !== "check" || (args[1]!.startsWith("-") && args[1] !== "-")) {
      checked = { schema_version: 1, valid: false, type: null, errors: [{ path: "$", code: "usage", message: HELP }], warnings: [] };
    } else {
      try {
        const file = args[1] === "-" ? Bun.stdin : Bun.file(resolve(context.root, args[1]!));
        if (args[1] !== "-" && file.size > 1024 * 1024) throw Error("Diagram input exceeds the 1 MiB parse bound");
        // Stream stdin with the same bound as files, before allocating a whole input.
        const reader = file.stream().getReader(), chunks: Uint8Array[] = []; let size = 0;
        try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
          if (size > 1024 * 1024) throw Error("Diagram input exceeds the 1 MiB parse bound"); chunks.push(part.value); }
        } finally { await reader.cancel(); }
        checked = checkDiagram(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
      } catch (error) { checked = { schema_version: 1, valid: false, type: null, errors: [{ path: "$", code: "input", message: (error as Error).message }], warnings: [] }; }
    }
    if (json) console.log(JSON.stringify(checked));
    else {
      console.log(checked.valid ? "Diagram is valid." : "Diagram is invalid.");
      for (const [severity, findings] of [["error", checked.errors], ["warning", checked.warnings]] as const)
        for (const item of findings) console.log(`${severity}: ${item.path}: ${item.message}`);
    }
    return checked.valid ? 0 : 1;
  },
};
export default command;
