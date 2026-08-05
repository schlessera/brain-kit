import { Brain, Newspaper, Search, BarChart3 } from "lucide-react";
import { motion } from "framer-motion";

export function WelcomeState({
  onAction,
}: {
  onAction: (action: string) => void;
}) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-8">
      <div className="flex flex-col items-center gap-8 text-center">
        {/* Brain icon with breathe animation */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        >
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-surface">
            <Brain className="h-8 w-8 text-primary" style={{ animation: "breathe 3s ease-in-out infinite" }} />
          </div>
        </motion.div>

        {/* Headline */}
        <motion.h1
          className="font-[family-name:var(--font-display)] text-3xl text-foreground"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1, ease: "easeOut" }}
        >
          What do you need to know?
        </motion.h1>

        {/* Suggestion cards */}
        <motion.div
          className="flex flex-col sm:flex-row gap-3"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2, ease: "easeOut" }}
        >
          <SuggestionCard
            icon={Newspaper}
            label="What's new?"
            description="Daily briefing"
            onClick={() => onAction("whatsup")}
            delay={0}
          />
          <SuggestionCard
            icon={Search}
            label="Search..."
            description="Find anything"
            onClick={() => onAction("search")}
            delay={0.05}
          />
          <SuggestionCard
            icon={BarChart3}
            label="Brain stats"
            description="Overview"
            onClick={() => onAction("stats")}
            delay={0.1}
          />
        </motion.div>

        {/* Keyboard hints */}
        <motion.div
          className="text-xs text-muted-foreground/40"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.4 }}
        >
          <span className="font-mono">/</span> for commands
        </motion.div>
      </div>
    </div>
  );
}

function SuggestionCard({
  icon: Icon,
  label,
  description,
  onClick,
  delay,
}: {
  icon: typeof Brain;
  label: string;
  description: string;
  onClick: () => void;
  delay: number;
}) {
  return (
    <motion.button
      onClick={onClick}
      className="flex w-44 flex-col items-center gap-2 rounded-xl border border-border bg-surface p-4 text-center transition-all duration-200 hover:border-primary/40 hover:bg-surface-raised"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.25 + delay, ease: "easeOut" }}
    >
      <Icon className="h-5 w-5 text-primary" />
      <div>
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-[11px] text-muted-foreground">{description}</div>
      </div>
    </motion.button>
  );
}
