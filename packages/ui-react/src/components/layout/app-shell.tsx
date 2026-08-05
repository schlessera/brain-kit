import type { ReactNode } from "react";
import { SideRail } from "./side-rail.js";
import { MobileTabBar } from "./mobile-tab-bar.js";
import { useChatStore, activeChat } from "../../stores/chat-store.js";
import { cn } from "../../lib/utils.js";

export function AppShell({ children }: { children: ReactNode }) {
  const isStreaming = useChatStore((s) => activeChat(s).isStreaming);

  return (
    <div className="flex h-[100dvh] bg-background text-foreground">
      <SideRail />
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Amber filament line */}
        <div
          className={cn("filament", isStreaming && "filament--active")}
        />
        <main className="flex flex-1 flex-col overflow-hidden pb-16 md:pb-0">
          {children}
        </main>
      </div>
      <MobileTabBar />
    </div>
  );
}
