import { EmptyState, SuggestionChips } from "@schlessera/brain-ui-kit";
import { motion } from "framer-motion";

/**
 * The chat's empty transcript, on the kit (S7): the design's `1h` first-run
 * `EmptyState` — a medallion, a serif title, one sentence — and the three
 * starting points as `SuggestionChips`, "follow-ups phrased as prompts the
 * user could have typed". Already props-only; the chat page routes the
 * action.
 */
export function WelcomeState({
  onAction,
}: {
  onAction: (action: string) => void;
}) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-8">
      <motion.div
        className="flex w-full max-w-md flex-col items-center gap-4"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      >
        <EmptyState
          variant="first-run"
          icon="brain"
          tone="amber"
          title="What do you need to know?"
          body="Ask in your own words. The brain reads its files, cites what it used, and asks before it writes."
          meta=""
          titleSize={26}
          pad={8}
        />
        <div className="w-full">
          <SuggestionChips
            label="Start with"
            items={[
              { label: "What's new?", icon: "digest", tone: "amber", onClick: () => onAction("whatsup") },
              { label: "Search…", icon: "search", onClick: () => onAction("search") },
              { label: "Brain stats", icon: "health", tone: "teal", onClick: () => onAction("stats") },
            ]}
          />
        </div>
        <div className="text-xs text-muted-foreground/60">
          <span className="font-mono">/</span> for commands
        </div>
      </motion.div>
    </div>
  );
}
