import { StreamingAnswer } from "@schlessera/brain-ui-kit";
import { describeRetry } from "@schlessera/brain-ui-sdk/internal/client";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { useBrainUiRoot } from "../../root-context.js";
import { useChatStore, type ChatMessage } from "../../stores/chat-store.js";

/** Waiting status only. Rich groups and the composer's Stop keep their owners. */
export function TurnStatus({ message, mode, target, restored, turnId }: {
  message: ChatMessage;
  mode: "thinking" | "approval" | "retry";
  target?: string;
  restored?: boolean;
  turnId?: string;
}) {
  const root = useBrainUiRoot();
  const sessionId = useChatStore(s => s.activeSessionId);
  const timingTurn = turnId ?? message.turnId;
  const hostStart = useStore(root.stores.trackers, s => {
    const latest = sessionId !== null ? s.evidence[sessionId]?.latest : undefined;
    return s.recoverySupported === true && timingTurn && latest?.turnId === timingTurn
      ? latest.startedAt : undefined;
  });
  const startedAt = hostStart ?? (message.turnShell || restored ? undefined : message.timestamp);
  const measured = typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt >= 0;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!measured) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [measured, startedAt, message.id]);
  const seconds = measured ? Math.max(0, Math.floor((now - startedAt) / 1000)) : undefined;
  const elapsed = seconds === undefined ? undefined
    : seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return <StreamingAnswer
    phase={mode === "thinking" ? "thinking" : undefined}
    phaseLabel={mode === "approval" ? "waiting for approval" : mode === "retry" ? "retrying" : undefined}
    target={mode === "retry" && message.retry ? describeRetry(message.retry) : target}
    elapsed={elapsed}
    pulse={mode !== "approval"}
    lines={2}
    bars={mode === "thinking"}
    stoppable={false}
  />;
}
