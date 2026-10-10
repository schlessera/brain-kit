import {
  RefreshCw,
  Search,
  Newspaper,
  Plus,
  BarChart3,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { motion } from "framer-motion";

interface Command {
  name: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

const commands: Command[] = [
  { name: "sync", label: "/sync", description: "Sync brain repository", icon: RefreshCw },
  { name: "search", label: "/search", description: "Search knowledge base", icon: Search },
  { name: "whatsup", label: "/whatsup", description: "Daily briefing", icon: Newspaper },
  { name: "add", label: "/add", description: "Add a note", icon: Plus },
  { name: "stats", label: "/stats", description: "Brain statistics", icon: BarChart3 },
];

/** The commands a draft's text after `/` could name, in palette order. */
export function matchCommands(filter: string): Command[] {
  const query = filter.toLowerCase();
  return commands.filter((cmd) => cmd.name.startsWith(query) || cmd.label.startsWith("/" + query));
}

/** The command a draft names exactly (`/stats`, any case, surrounding space ignored), or null. */
export function exactCommand(draft: string): string | null {
  const name = /^\/([a-z]+)$/i.exec(draft.trim())?.[1]?.toLowerCase();
  return name && commands.some((cmd) => cmd.name === name) ? name : null;
}

/**
 * The slash-command palette above the composer. The composer owns which row is
 * active (Enter runs it, the arrows move it, #1504); the row is marked for
 * assistive technology and announced, while focus stays in the field.
 */
export function CommandPalette({
  filter,
  activeIndex = 0,
  onSelect,
}: {
  filter: string;
  activeIndex?: number;
  onSelect: (command: string) => void;
}) {
  const filtered = matchCommands(filter);
  const active = Math.min(Math.max(activeIndex, 0), filtered.length - 1);

  if (filtered.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.15 }}
      className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-border bg-surface-overlay shadow-2xl"
      data-command-palette=""
    >
      <span role="status" aria-label="Slash command" className="sr-only">
        {`${filtered[active]!.label}, ${filtered[active]!.description}, ${active + 1} of ${filtered.length}`}
      </span>
      {filtered.map((cmd, index) => (
        <button
          // raw-button: row — composite slash command with icon, mono name and description
          key={cmd.name}
          onClick={() => onSelect(cmd.name)}
          aria-current={index === active ? "true" : undefined}
          style={{ "--hv-bg": "var(--bk-color-raised)", ...(index === active ? { background: "var(--bk-color-raised)" } : null) } as CSSProperties}
          className="bk-row flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors"
        >
          <cmd.icon className="h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <div className="font-[family-name:var(--font-mono)] text-[13px] font-medium text-foreground">
              {cmd.label}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {cmd.description}
            </div>
          </div>
        </button>
      ))}
    </motion.div>
  );
}
