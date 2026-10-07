import type { CommandModule } from "@schlessera/brain";
import { getContext, resolveCompletionProvider, geminiCompletions } from "@schlessera/brain/internal";
import type { VideoConfig } from "./module.js";
import { DOCS, DISCLOSURE, seconds, watch } from "./watch.js";

const HELP = `brain video watch <url|path> [--question TEXT] [--start T] [--end T] [--json]

Watch a public YouTube URL or local video using the configured Gemini completion provider.
Times: seconds, mm:ss or hh:mm:ss. Relative paths resolve from the brain root.
${DISCLOSURE}
No downloads, local engine or silent provider fallback. See ${DOCS}`;

const command: CommandModule<VideoConfig> = {
  summary: "Watch a video with Gemini and return timestamped observations",
  helpBlock: HELP,
  async run(argv, ctx) {
    try {
      if (!argv.length || argv.includes("--help")) { console.log(HELP); return 0; }
      if (argv[0] !== "watch") throw new Error("Expected: brain video watch <url|path>");
      const positional: string[] = [];
      const flags: Record<string, string> = {};
      for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
        if (arg === "--json" || arg === "--human") continue;
        if (!arg.startsWith("--")) { positional.push(arg); continue; }
        const name = arg.slice(2);
        if (!["question", "start", "end"].includes(name)) throw new Error(`Unknown option: ${arg}`);
        if (flags[name] !== undefined) throw new Error(`Duplicate option: ${arg}`);
        const value = argv[++i];
        if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
        flags[name] = value;
      }
      if (positional.length !== 1) throw new Error("Expected one video URL or path");
      const clip = { start: flags.start !== undefined ? seconds(flags.start) : null, end: flags.end !== undefined ? seconds(flags.end) : null };
      const completions = getContext().config?.completions;
      // Honor custom/configured providers; only the built-in Gemini model is
      // overridden by this module's model setting. Never replace Anthropic.
      const builtin = !completions?.provider || completions.provider === "gemini-flash";
      const provider = resolveCompletionProvider(builtin ? {
        ...completions, provider: geminiCompletions({ model: ctx.config.model, apiKeyEnv: completions?.apiKeyEnv }),
      } : completions);
      const model = builtin ? ctx.config.model : provider.id.split("+fallback:")[0].replace(/^[^:]+:/, "");
      const result = await watch(positional[0], {
        root: ctx.root, question: flags.question ?? "Summarize the main events and what is demonstrated, with timestamps.",
        clip, model, timeoutMs: ctx.config.timeoutMs, provider,
      });
      if (ctx.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(result.answer);
        for (const warning of result.warnings) console.error(`Warning: ${warning}`);
      }
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Video request failed";
      console.error(`${message}\nSee ${DOCS}`);
      return 1;
    }
  },
};
export default command;
