import {
  RefreshCw,
  Search,
  Newspaper,
  Plus,
  BarChart3,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
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

export function CommandPalette({
  filter,
  onSelect,
}: {
  filter: string;
  onSelect: (command: string) => void;
}) {
  const filtered = commands.filter(
    (cmd) =>
      cmd.name.startsWith(filter.toLowerCase()) ||
      cmd.label.startsWith("/" + filter.toLowerCase())
  );

  if (filtered.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.15 }}
      className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-border bg-surface-overlay shadow-2xl"
    >
      {filtered.map((cmd) => (
        <button
          key={cmd.name}
          onClick={() => onSelect(cmd.name)}
          className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-raised"
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
