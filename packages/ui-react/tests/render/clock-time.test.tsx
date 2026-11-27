// Render test for the shared clock time (#4736): a message stamp and the
// draft indicator print one timestamp the same way, 24-hour `HH:MM`, whatever
// the runtime's default locale (Bun's is `en-US`, a 12-hour one). Queries
// come from `render()`, never `screen` — see tests/render/dom.ts for why.
import { unregisterClockTimeDom } from "./clock-time-dom.js";

import { afterAll, afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { draftIndicatorView } from "../../src/lib/draft-indicator.js";
import type { ChatMessage } from "../../src/stores/chat-state.js";
import type { ComposerDraft } from "../../src/stores/draft-state.js";

afterEach(cleanup);
afterAll(unregisterClockTimeDom);

const noop = () => {};
// Built from local components, so the expected text does not depend on the
// machine's time zone.
const AT_2141 = new Date(2026, 6, 12, 21, 41).getTime();

test("a message stamp and the draft indicator both read 21:41", () => {
  const message: ChatMessage = { id: "m-ithaca", role: "user", content: "Ready the raft for Ithaca.", toolCalls: [], parts: [], isStreaming: false, timestamp: AT_2141 };
  const bubble = render(<MessageBubble message={message} onToolApproval={noop} onAskUserSubmit={noop} onAskUserCancel={noop} onAskUserListSubmit={noop} />);
  expect(bubble.container.textContent).toContain("21:41");
  expect(bubble.container.textContent).not.toMatch(/\b(AM|PM)\b/);

  const draft: ComposerDraft = {
    draftId: "draft-ithaca", sessionId: "odysseus-ithaca", text: "Ready the raft for Ithaca.", attachments: [], files: [], editedAt: AT_2141, edit: 3,
    host: { revision: 4, edit: 3, sessionId: "odysseus-ithaca", attachmentIds: [], fileIds: [], updatedAt: AT_2141 },
    uploads: new Map(), failure: null, savingSince: null, conflict: null, uncertain: false, bind: null,
  };
  const view = draftIndicatorView({ draft, store: { supported: true, limits: { maxTextBytes: 65_536, maxDraftBytes: 8_388_608, maxDrafts: 100, maxTotalBytes: 268_435_456 } }, queued: [], online: true });
  expect(view.key !== "none" && view.summary).toContain("Draft saved 21:41");
});
