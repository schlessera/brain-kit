/**
 * Ask-user exchanges (#1361): question, list, rank and form cards, their
 * answers, dismissal and reopening, and the delivery state of each answer.
 */
import type { AskUserExchange, ChatState, SessionChat } from "../chat-state.js";
import type { ChatSliceContext } from "./buffers.js";

/** The exchange has an outcome: answered (in any of the four shapes) or dismissed. */
export function isSettledExchange(exchange: AskUserExchange): boolean {
  return !!(exchange.answers || exchange.order || exchange.formAnswers || exchange.cancelled);
}

/**
 * Open an ask exchange: attached to the streaming assistant message, where the
 * transcript draws it, and held as the session's pending exchange. `ask_user`
 * and `ask_user_list` share the slot, so the composer, the suggestions row and
 * the tool-result cleanup treat either the same way.
 *
 * One request is one card (#910). The host re-delivers a pending request on
 * every reconnect and after `session_resume`, and history may already have
 * rebuilt it under the same id, so a request already in the buffer is
 * UPDATED, never appended again:
 *
 * - a settled card stays settled: a late or replayed request frame cannot
 *   revive an answered or dismissed question;
 * - a pending card keeps its payload and whatever the user is drafting in it,
 *   and learns its turn if it did not know it;
 * - a request claiming a different turn than the card already holds is a
 *   contradiction, not an update, and is ignored. The host's receipt is what
 *   decides which binding is real.
 */
function addExchange(
  chat: SessionChat,
  exchange: AskUserExchange
): Partial<Pick<SessionChat, "messages" | "askUser">> {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const message = chat.messages[i]!;
    const index = message.askUserExchanges?.findIndex((e) => e.requestId === exchange.requestId) ?? -1;
    if (index === -1) continue;
    const existing = message.askUserExchanges![index]!;
    if (isSettledExchange(existing)) return {};
    if (existing.turnId && exchange.turnId && existing.turnId !== exchange.turnId) return {};
    const merged: AskUserExchange =
      existing.turnId || !exchange.turnId ? existing : { ...existing, turnId: exchange.turnId };
    const msgs = [...chat.messages];
    const exchanges = [...message.askUserExchanges!];
    exchanges[index] = merged;
    msgs[i] = { ...message, askUserExchanges: exchanges };
    const slot = chat.askUser;
    const askUser = !slot || slot.requestId === merged.requestId || isSettledExchange(slot) ? merged : slot;
    return { messages: msgs, askUser };
  }
  const msgs = [...chat.messages];
  const lastIdx = msgs.length - 1;
  const last = msgs[lastIdx];
  if (last?.role === "assistant") {
    msgs[lastIdx] = {
      ...last,
      askUserExchanges: [...(last.askUserExchanges ?? []), exchange],
    };
  }
  return { messages: msgs, askUser: exchange };
}

type AskUserSliceSlice = Pick<ChatState,
  | "setAskUserRequest"
  | "setAskUserListRequest"
  | "setAskUserRankRequest"
  | "submitAskUserRankOrder"
  | "setAskUserFormRequest"
  | "submitAskUserFormAnswers"
  | "submitAskUserListAnswers"
  | "submitAskUserAnswers"
  | "cancelAskUser"
  | "reopenAskExchange"
  | "deliveries"
  | "setDelivery"
  | "clearAskUser"
  | "endTurnQuestions"
>;

export function createAskUserSlice(ctx: ChatSliceContext): AskUserSliceSlice {
  const { set, mutateBuffer } = ctx;
  return {
    setAskUserRequest: (key, requestId, questions, turnId) =>
      mutateBuffer(key, (chat) => addExchange(chat, { requestId, questions, ...(turnId ? { turnId } : {}) })),

    setAskUserListRequest: (key, requestId, list, turnId) =>
      mutateBuffer(key, (chat) => addExchange(chat, { requestId, questions: [], list, ...(turnId ? { turnId } : {}) })),

    setAskUserRankRequest: (key, requestId, rank, turnId) =>
      mutateBuffer(key, (chat) => addExchange(chat, { requestId, questions: [], rank, ...(turnId ? { turnId } : {}) })),

    submitAskUserRankOrder: (key, requestId, order, unchanged) =>
      mutateBuffer(key, (chat) => {
        const answeredAt = Date.now();
        const update = (e: AskUserExchange): AskUserExchange =>
          e.requestId === requestId
            ? { ...e, order, unchanged, answeredAt }
            : e;
        const msgs = chat.messages.map((m) =>
          m.askUserExchanges?.some((e) => e.requestId === requestId)
            ? { ...m, askUserExchanges: m.askUserExchanges.map(update) }
            : m
        );
        const askUser =
          chat.askUser?.requestId === requestId ? update(chat.askUser) : chat.askUser;
        return { messages: msgs, askUser };
      }),

    setAskUserFormRequest: (key, requestId, form, turnId) =>
      mutateBuffer(key, (chat) => addExchange(chat, { requestId, questions: [], form, ...(turnId ? { turnId } : {}) })),

    submitAskUserFormAnswers: (key, requestId, formAnswers, visibleNodes) =>
      mutateBuffer(key, (chat) => {
        const answeredAt = Date.now();
        const update = (e: AskUserExchange): AskUserExchange =>
          e.requestId === requestId
            ? { ...e, formAnswers, visibleNodes, answeredAt }
            : e;
        const msgs = chat.messages.map((m) =>
          m.askUserExchanges?.some((e) => e.requestId === requestId)
            ? { ...m, askUserExchanges: m.askUserExchanges.map(update) }
            : m
        );
        const askUser =
          chat.askUser?.requestId === requestId ? update(chat.askUser) : chat.askUser;
        return { messages: msgs, askUser };
      }),

    submitAskUserListAnswers: (key, requestId, answers, notes) =>
      mutateBuffer(key, (chat) => {
        const answeredAt = Date.now();
        const update = (e: AskUserExchange): AskUserExchange =>
          e.requestId === requestId
            ? { ...e, answers, answeredAt, ...(notes && Object.keys(notes).length ? { notes } : {}) }
            : e;
        const msgs = chat.messages.map((m) =>
          m.askUserExchanges?.some((e) => e.requestId === requestId)
            ? { ...m, askUserExchanges: m.askUserExchanges.map(update) }
            : m
        );
        const askUser =
          chat.askUser?.requestId === requestId ? update(chat.askUser) : chat.askUser;
        return { messages: msgs, askUser };
      }),

    submitAskUserAnswers: (key, requestId, answers, annotations, typed) =>
      mutateBuffer(key, (chat) => {
        const answeredAt = Date.now();
        const update = (e: AskUserExchange): AskUserExchange =>
          e.requestId === requestId
            ? { ...e, answers, annotations, answeredAt, ...(typed ? { typed: true } : {}) }
            : e;
        const msgs = chat.messages.map((m) =>
          m.askUserExchanges?.some((e) => e.requestId === requestId)
            ? { ...m, askUserExchanges: m.askUserExchanges.map(update) }
            : m
        );
        const askUser =
          chat.askUser?.requestId === requestId ? update(chat.askUser) : chat.askUser;
        return { messages: msgs, askUser };
      }),

    cancelAskUser: (key, requestId) =>
      mutateBuffer(key, (chat) => {
        const update = (e: AskUserExchange): AskUserExchange =>
          e.requestId === requestId ? { ...e, cancelled: true } : e;
        const msgs = chat.messages.map((m) =>
          m.askUserExchanges?.some((e) => e.requestId === requestId)
            ? { ...m, askUserExchanges: m.askUserExchanges.map(update) }
            : m
        );
        const askUser =
          chat.askUser?.requestId === requestId ? update(chat.askUser) : chat.askUser;
        return { messages: msgs, askUser };
      }),

    reopenAskExchange: (key, requestId) =>
      mutateBuffer(key, (chat) => {
        let reopened: AskUserExchange | null = null;
        const msgs = chat.messages.map((m) => {
          if (!m.askUserExchanges?.some((e) => e.requestId === requestId)) return m;
          return {
            ...m,
            askUserExchanges: m.askUserExchanges.map((e) => {
              if (e.requestId !== requestId) return e;
              const {
                answers: _a, annotations: _n, notes: _o, order: _r, unchanged: _u,
                formAnswers: _f, visibleNodes: _v, typed: _t, answeredAt: _w, cancelled: _c,
                ...rest
              } = e;
              reopened = rest;
              return rest;
            }),
          };
        });
        return reopened ? { messages: msgs, askUser: reopened } : {};
      }),

    deliveries: {},
    setDelivery: (requestId, delivery) =>
      set((state) => {
        const deliveries = { ...state.deliveries };
        if (delivery) deliveries[requestId] = delivery;
        else delete deliveries[requestId];
        return { deliveries };
      }),

    clearAskUser: (key) => mutateBuffer(key, () => ({ askUser: null })),

    endTurnQuestions: (key, turnId, endedBy) => mutateBuffer(key, (chat) => {
      const end = (exchange: AskUserExchange): AskUserExchange => {
        if (turnId && exchange.turnId !== turnId) return exchange;
        // A question this turn's earlier terminal frame already ended
        // learns why, when the host says so (#3356).
        if (exchange.terminal) return endedBy && exchange.endedBy !== endedBy ? { ...exchange, endedBy } : exchange;
        if (exchange.answers || exchange.order || exchange.formAnswers || exchange.cancelled) return exchange;
        return { ...exchange, cancelled: true, terminal: true, ...(endedBy ? { endedBy } : {}) };
      };
      return {
        messages: chat.messages.map((message) => message.askUserExchanges ? { ...message, askUserExchanges: message.askUserExchanges.map(end) } : message),
        askUser: chat.askUser ? end(chat.askUser) : null,
      };
    }),
  };
}
