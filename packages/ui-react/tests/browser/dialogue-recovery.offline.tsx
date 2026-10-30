/// <reference types="@vitest/browser-playwright" />
import { test, expect, beforeAll, afterAll, vi, type TestContext } from "vitest";
import { commands, page } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { transcriptTimelineFor } from "../../src/lib/transcript-timeline.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import { installFaultNetwork } from "./offline/fault-network.js";
let styles: HTMLStyleElement;
beforeAll(async () => {
  styles = document.createElement("style");
  styles.textContent = await commands.formConsumerStyles();
  document.head.append(styles);
});
afterAll(() => styles.remove());
function microphone(ctx: TestContext) {
  const audio = new AudioContext(),
    oscillator = audio.createOscillator(),
    destination = audio.createMediaStreamDestination();
  oscillator.connect(destination);
  oscillator.start();
  void audio.resume();
  const media = navigator.mediaDevices,
    descriptor = Object.getOwnPropertyDescriptor(media, "getUserMedia"),
    streams: MediaStream[] = [];
  Object.defineProperty(media, "getUserMedia", {
    configurable: true,
    writable: true,
    value: async () => {
      const stream = destination.stream.clone();
      streams.push(stream);
      return stream;
    },
  });
  ctx.onTestFinished(() => {
    if (descriptor) Object.defineProperty(media, "getUserMedia", descriptor);
    else Reflect.deleteProperty(media, "getUserMedia");
    oscillator.stop();
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    void audio.close();
  });
}
async function view(
  ctx: TestContext,
  sessionId: string | null,
  ownerId?: string
) {
  const network = installFaultNetwork({
    routes: (url) =>
      url.pathname.endsWith("/sessions")
        ? Response.json({ sessions: [] })
        : undefined,
    onOpen(socket) {
      socket.deliver({
        type: "server_hello",
        protocolRev: 5,
        principalKey: "odysseus",
        capabilities: {
          liveConversation: true,
          conversationPause: true,
          sessionDialogue: true,
        },
      });
    },
  });
  const ui = createBrainUiRoot({ storage: null, request: network.request });
  if (sessionId && ownerId)
    ui.stores.chat.getState().setHistoryOwner(sessionId, ownerId);
  ui.stores.chat.getState().setActiveSession(sessionId);
  const element = document.createElement("div");
  element.style.cssText = "position:fixed;inset:0;width:390px;height:700px";
  document.body.append(element);
  const renderer = createRoot(element);
  flushSync(() =>
    renderer.render(
      <BrainUiProvider root={ui}>
        <ChatPage />
      </BrainUiProvider>
    )
  );
  const release = ui.connection.connect();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    flushSync(() => renderer.unmount());
    release();
    ui.dispose();
    network.restore();
    element.remove();
  };
  ctx.onTestFinished(close);
  await expect
    .poll(() => ui.stores.connection.getState().wsStatus)
    .toBe("connected");
  return { ui, network, element, close, socket: network.socket()! };
}
for (const first of ["gemini", "gpt"] as const)
  for (const second of ["gemini", "gpt"] as const)
    test(`${first} to ${second}: durable back-and-forth survives Leave, cold root, host restart and new native ID`, async (ctx) => {
      microphone(ctx);
      const fixture = (await commands.conversationServer({
        op: "start",
        durable: true,
        provider: first,
      })) as { id: string };
      ctx.onTestFinished(async () => {
        await commands.conversationServer({ op: "stop", id: fixture.id });
      });
      let s = await view(ctx, null),
        cursor = 0;
      let result: any;
      const observed: ServerMessage[] = [];
      const pump = async (
        provider: unknown[] = [],
        release = false,
        restart = false,
        engine?: "gemini" | "gpt"
      ) => {
        const client = s.socket.sent
          .slice(cursor)
          .map((b) => JSON.parse(String(b.data)));
        cursor = s.socket.sent.length;
        result = (await commands.conversationServer({
          op: "step",
          id: fixture.id,
          client,
          provider,
          release,
          restart,
          engine,
        })) as any;
        for (const frame of result.frames as ServerMessage[]) {
          observed.push(frame);
          s.socket.deliver(frame);
        }
        return result;
      };
      await pump();
      s.ui.connection.conversation.enter();
      await expect
        .poll(async () => {
          await pump();
          return s.ui.connection.conversation.state.getState().profile;
        })
        .not.toBeNull();
      s.ui.connection.conversation.start();
      await expect
        .poll(() => s.ui.connection.conversation.state.getState().micOn)
        .toBe(true);
      await expect
        .poll(() => s.socket.frames("conversation_audio").length)
        .toBeGreaterThan(0);
      await pump();
      const old = s.ui.connection.conversation.state.getState().profile!;
      const input = (n: number, text: string) =>
        first === "gemini"
          ? { serverContent: { inputTranscription: { text } } }
          : {
              type: "session.input_transcript.delta",
              event_id: `spoken-${n}`,
              delta: text,
              start_ms: n * 1000,
              end_ms: n * 1000 + 500,
            };
      const reply = (n: number, text: string) =>
        first === "gemini"
          ? {
              serverContent: {
                outputTranscription: { text },
                turnComplete: true,
              },
            }
          : {
              type: "session.output_transcript.delta",
              event_id: `reply-${n}`,
              delta: text,
              start_ms: n * 1000 + 600,
              end_ms: n * 1000 + 800,
            };
      const ingress = [
        input(0, "Where is the departure note?"),
        reply(0, "We can look for it."),
        input(1, "Research the departure signal."),
      ];
      const request =
        first === "gemini"
          ? {
              toolCall: {
                functionCalls: [{ id: "research", name: "host_task" }],
              },
            }
          : {
              type: "session.delegation.created",
              event_id: "research",
              offset_ms: 1500,
              delegation: {
                id: "research",
                type: "delegation",
                target: "client",
              },
            };
      await pump([...ingress, request]);
      await expect
        .poll(async () => {
          await pump();
          return JSON.stringify({
            tasks: result.tasks,
            receipts: observed.filter(
              (f) =>
                f.type === "conversation_work" ||
                f.type === "error" ||
                f.type === "conversation_closed"
            ),
          });
        })
        .toContain('"tasks":1');
      await pump([
        input(2, "Explain the mast while that runs."),
        reply(2, "The mast supports the sail."),
      ]);
      await pump([], true);
      await expect
        .poll(async () => {
          await pump();
          return s.element.textContent;
        })
        .toContain("The departure signal is a bronze owl.");
      await pump([input(3, "What was that signal?")]);
      const expected = [
        "Where is the departure note?",
        "We can look for it.",
        "Research the departure signal.",
        "Explain the mast while that runs.",
        "The mast supports the sail.",
        "The departure signal is a bronze owl.",
        "What was that signal?",
      ];
      const exact = () =>
        [
          ...s.element.querySelectorAll(
            "[data-recognized-text],[data-conversation-output],.chat-message-body"
          ),
        ]
          .map((e) => e.textContent ?? "")
          .join("\n");
      for (const text of expected) await expect.poll(exact).toContain(text);
      const rawVoice = result.rows
        .map((r: any) => JSON.parse(r.payload))
        .filter((r: any) => r.kind === "voice");
      expect(rawVoice.map((r: any) => r.event.text)).toEqual([
        "Where is the departure note?",
        "We can look for it.",
        "Research the departure signal.",
        "Explain the mast while that runs.",
        "The mast supports the sail.",
        "What was that signal?",
      ]);
      expect(
        rawVoice.every(
          (r: any) =>
            r.providerId === (first === "gemini" ? "gemini-live" : "gpt-live")
        )
      ).toBe(true);
      const sessionId = s.ui.stores.chat.getState().activeSessionId!;
      expect(sessionId).toBe("odysseus-ithaca");
      s.ui.connection.conversation.leave();
      await pump();
      const retained =
        s.ui.connection.conversation.state.getState().dialogue[sessionId]!;
      flushSync(()=>s.ui.stores.chat.getState().setActiveSession("other-chat"));
      s.socket.deliver({ type: "dialogue_history", ...retained });
      await expect
        .poll(() => s.element.textContent)
        .not.toContain("Where is the departure note?");
      s.ui.stores.chat.getState().setActiveSession(sessionId);
      await expect.poll(exact).toContain("Where is the departure note?");
      s.close();
      s = await view(ctx, sessionId);
      cursor = 0;
      await pump([], false, true, second);
      s.socket.send(JSON.stringify({ type: "session_resume", sessionId }));
      await expect
        .poll(async () => {
          await pump();
          return exact();
        })
        .toContain(expected[0]!);
      for (const text of expected) expect(exact()).toContain(text);
      const body = exact();
      expect(expected.map((t) => body.indexOf(t))).toEqual(
        expected.map((t) => body.indexOf(t)).sort((a, b) => a - b)
      );
      expect(result.tasks).toBe(1);
      expect(s.ui.connection.conversation.state.getState().micOn).toBe(false);
      s.ui.connection.conversation.enter();
      await expect
        .poll(async () => {
          await pump();
          return s.ui.connection.conversation.state.getState().profile;
        })
        .not.toBeNull();
      const next = s.ui.connection.conversation.state.getState().profile!;
      expect(next.conversationId).not.toBe(old.conversationId);
      expect(next.providerId).toBe(
        second === "gemini" ? "gemini-live" : "gpt-live"
      );
      expect(
        s.ui.connection.conversation.state
          .getState()
          .dialogue[sessionId]!.records.filter(
            (r) => r.evidence.kind === "voice"
          )
          .every(
            (r) =>
              r.evidence.kind === "voice" &&
              r.evidence.providerId === old.providerId
          )
      ).toBe(true);
      expect(result.tasks).toBe(1);
      s.ui.connection.conversation.leave();
      await pump();
      // #3178 separately supplies provider history. Visible restoration makes no
      // claim that a new engine received or understood these prior words.
    });

for (const provider of ["gemini", "gpt"] as const)
  test(`${provider}: host-only spoken history reopens without inventing a backend session or task`, async (ctx) => {
    microphone(ctx);
    const fixture = (await commands.conversationServer({
      op: "start",
      durable: true,
      provider,
    })) as { id: string };
    ctx.onTestFinished(async () => {
      await commands.conversationServer({ op: "stop", id: fixture.id });
    });
    let s = await view(ctx, null),
      cursor = 0,
      result: any;
    const pump = async (providerFrames: unknown[] = [], restart = false) => {
      const client = s.socket.sent
        .slice(cursor)
        .map((b) => JSON.parse(String(b.data)));
      cursor = s.socket.sent.length;
      result = await commands.conversationServer({
        op: "step",
        id: fixture.id,
        client,
        provider: providerFrames,
        restart,
      });
      for (const frame of result.frames as ServerMessage[])
        s.socket.deliver(frame);
    };
    await pump();
    s.ui.connection.conversation.enter();
    await expect
      .poll(async () => {
        await pump();
        return s.ui.connection.conversation.state.getState().profile;
      })
      .not.toBeNull();
    s.ui.connection.conversation.start();
    await expect
      .poll(() => s.socket.frames("conversation_audio").length)
      .toBeGreaterThan(0);
    await pump();
    await pump([
      provider === "gemini"
        ? {
            serverContent: {
              inputTranscription: { text: "Keep the mast in mind." },
            },
          }
        : {
            type: "session.input_transcript.delta",
            event_id: "host-only",
            delta: "Keep the mast in mind.",
            start_ms: 0,
            end_ms: 500,
          },
    ]);
    await expect
      .poll(() => s.element.textContent)
      .toContain("Keep the mast in mind.");
    const longInput = Array.from(
      { length: 140 },
      (_, i) => `Mast observation ${i}: ${"The sail remains ready. ".repeat(6)}`
    );
    const longReplies = Array.from(
      { length: 35 },
      (_, i) => `Reply ${i}: ${"Keep the mast secure. ".repeat(28)}`
    );
    const ingress = [
      ...longInput.map((text, i) =>
        provider === "gemini"
          ? { serverContent: { inputTranscription: { text } } }
          : {
              type: "session.input_transcript.delta",
              event_id: `long-${i}`,
              delta: text,
              start_ms: 1000 + i * 1000,
              end_ms: 1500 + i * 1000,
            }
      ),
      ...longReplies.map((text, i) =>
        provider === "gemini"
          ? {
              serverContent: {
                outputTranscription: { text },
                turnComplete: true,
              },
            }
          : {
              type: "session.output_transcript.delta",
              event_id: `reply-${i}`,
              delta: text,
              start_ms: 200000 + i * 1000,
              end_ms: 200500 + i * 1000,
            }
      ),
    ];
    await pump(ingress);
    await expect
      .poll(async () => {
        await pump();
        return result.rows.length;
      })
      .toBe(176);
    expect(s.ui.connection.conversation.state.getState().micOn).toBe(true);
    const retainedTexts = result.rows
      .map((r: any) => JSON.parse(r.payload))
      .filter((r: any) => r.kind === "voice")
      .map((r: any) => r.event.text);
    expect(retainedTexts).toEqual([
      "Keep the mast in mind.",
      ...longInput,
      ...longReplies,
    ]);
    const owner =
      s.ui.connection.conversation.state.getState().profile!.historyOwnerId!;
    expect(owner).toBeTruthy();
    expect(result.tasks).toBe(0);
    expect(s.ui.stores.chat.getState().activeSessionId).toBeNull();
    s.ui.connection.conversation.leave();
    await pump();
    s.close();
    const key = `dialogue:${owner}`;
    s = await view(ctx, key, owner);
    cursor = 0;
    await pump([], true);
    s.ui.connection.conversation.loadDialogue(key);
    await expect
      .poll(async () => {
        await pump();
        return s.element.textContent;
      })
      .toContain("Keep the mast in mind.");
    expect(result.tasks).toBe(0);
    expect(
      s.socket
        .frames("session_resume")
        .some((f) => String(f.sessionId).startsWith("dialogue:"))
    ).toBe(false);
    expect(s.ui.stores.chat.getState().buffers[key]!.messages).toHaveLength(0);
    expect(
      s.ui.connection.send({
        type: "chat_message",
        sessionId: key,
        text: "Find the departure note.",
        requestId: "typed-adoption",
      })
    ).toBe(true);
    await expect
      .poll(async () => {
        await pump();
        return result.tasks;
      })
      .toBe(1);
    await expect
      .poll(async () => {
        await pump();
        return s.ui.stores.chat.getState().activeSessionId;
      })
      .not.toBe(key);
    const bound = s.ui.stores.chat.getState().activeSessionId!;
    expect(bound).toBeTruthy();
    expect(s.socket.frames("chat_message").at(-1)).toMatchObject({
      historyOwnerId: owner,
      text: "Find the departure note.",
    });
    expect(s.socket.frames("chat_message").at(-1)?.sessionId).toBeUndefined();
    expect(
      result.rows.filter((r: any) => JSON.parse(r.payload).kind === "voice")
    ).toHaveLength(176);
  });

for (const provider of ["gpt", "gemini"] as const)
  for (const nativeHistory of [true, false])
  for (const correlated of [true, false])
  for (const bound of ["fragments", "characters"] as const)
    test(`${provider} nativeHistory=${nativeHistory} correlated=${correlated}: correlated capture separates the ${bound} review bound from durable discussion`, async (ctx) => {
      microphone(ctx);
      const fixture = (await commands.conversationServer({
        op: "start",
        durable: true,
        nativeHistory,
        provider,
      })) as { id: string };
      ctx.onTestFinished(async () => {
        await commands.conversationServer({ op: "stop", id: fixture.id });
      });
      const s = await view(ctx, null);
      let cursor = 0,
        result: any;
      const received: ServerMessage[] = [];
      const pump = async (providerFrames: unknown[] = []) => {
        const client = s.socket.sent
          .slice(cursor)
          .map((b) => JSON.parse(String(b.data)));
        cursor = s.socket.sent.length;
        result = await commands.conversationServer({
          op: "step",
          id: fixture.id,
          client,
          provider: providerFrames,
        });
        for (const frame of result.frames) {
          received.push(frame);
          s.socket.deliver(frame);
        }
      };
      await pump();
      s.ui.connection.conversation.enter();
      await expect
        .poll(async () => {
          await pump();
          return s.ui.connection.conversation.state.getState().profile;
        })
        .not.toBeNull();
      s.ui.connection.conversation.start();
      await expect
        .poll(() => s.socket.frames("conversation_audio").length)
        .toBeGreaterThan(0);
      await pump();
      const audio = result.sent.find(
        (m: any) => m.type === "session.input_audio.append"
      );
      if (provider === "gpt") expect(audio.event_id).toBeTruthy();
      const text = Array.from(
        { length: bound === "fragments" ? 140 : 30 },
        (_, i) =>
          `Observation ${i}: ${
            bound === "fragments" ? "mast ready." : "mast ".repeat(150)
          }`
      );
      await pump(
        text.map((delta, i) =>
          provider === "gpt"
            ? {
                type: "session.input_transcript.delta",
                event_id: `captured-${i}`,
                ...(correlated ? {client_event_id: audio.event_id} : {}),
                delta,
                start_ms: i * 1000,
                end_ms: i * 1000 + 500,
              }
            : { serverContent: { inputTranscription: { text: delta } } }
        )
      );
      expect(
        result.rows.map((r: any) => JSON.parse(r.payload).event.text)
      ).toEqual(text);
      const events = received.filter(
        (f): f is Extract<ServerMessage, { type: "conversation_event" }> =>
          f.type === "conversation_event"
      );
      // Gemini deliberately supplies unassigned evidence in contextual mode. Only
      // GPT exposes exact append-command correlation; never invent it for Gemini.
      expect(
        events.filter(
          (f) =>
            f.event.kind ===
            (provider === "gpt" && correlated || provider === "gemini" && !nativeHistory
              ? "input_fragment"
              : "unassigned_input_fragment")
        )
      ).toHaveLength(text.length);
      const state=s.ui.connection.conversation.state.getState();
      expect(state.micOn).toBe(true);
      expect(state.profile!.capabilities.contextualTasks).toBe(nativeHistory ? "supported" : "unsupported");
      if (!nativeHistory) {
        expect(state.unassigned.length).toBeLessThanOrEqual(128);
        expect(state.unassigned.reduce((n,f)=>n+f.text.length,0)).toBeLessThanOrEqual(16000);
        if(provider==="gemini" || correlated) {
          expect(state.text.length).toBeLessThanOrEqual(8000);
          const before=s.socket.frames("conversation_commit").length;
          expect(s.ui.connection.conversation.commit(state.token)).toBe(false);
          expect(s.socket.frames("conversation_commit")).toHaveLength(before);
          expect(s.element.textContent).toContain("Only bounded recognition context remains");
        }
      }
      expect(received.filter((f) => f.type === "conversation_closed")).toEqual(
        []
      );
      expect(result.tasks).toBe(0);
      s.ui.connection.conversation.leave();
      await pump();
    });

for (const provider of ["gpt", "gemini"] as const)
  test(`${provider}: quota preserves every observed input/reply tail in order and restores only committed evidence`, async (ctx) => {
    microphone(ctx);
    const fixture = (await commands.conversationServer({
      op: "start",
      durable: true,
      provider,
    })) as { id: string };
    ctx.onTestFinished(async () => {
      await commands.conversationServer({ op: "stop", id: fixture.id });
    });
    let s = await view(ctx, null),
      cursor = 0,
      result: any;
    const received: ServerMessage[] = [];
    const pump = async (
      providerFrames: unknown[] = [],
      quota = false,
      restart = false
    ) => {
      const client = s.socket.sent
        .slice(cursor)
        .map((b) => JSON.parse(String(b.data)));
      cursor = s.socket.sent.length;
      result = await commands.conversationServer({
        op: "step",
        id: fixture.id,
        client,
        provider: providerFrames,
        quota,
        restart,
      });
      for (const frame of result.frames) {
        received.push(frame);
        s.socket.deliver(frame);
      }
    };
    await pump();
    s.ui.connection.conversation.enter();
    await expect
      .poll(async () => {
        await pump();
        return s.ui.connection.conversation.state.getState().profile;
      })
      .not.toBeNull();
    s.ui.connection.conversation.start();
    await expect
      .poll(() => s.socket.frames("conversation_audio").length)
      .toBeGreaterThan(0);
    await pump();
    const owner =
      s.ui.connection.conversation.state.getState().profile!.historyOwnerId!;
    s.socket.deliver({
      type: "error",
      code: "DIALOGUE_STORAGE",
      historyOwnerId: "other-owner",
      message: "Another chat could not be saved.",
    });
    expect(s.ui.connection.conversation.state.getState().micOn).toBe(true);

    const inputs = Array.from(
      { length: 30 },
      (_, i) => `Observation ${i}: ${"mast ".repeat(390)}`
    );
    const outputs = Array.from(
      { length: 30 },
      (_, i) => `Reply ${i}: ${"sail ".repeat(390)}`
    );
    const source = inputs.flatMap((text, i) => [
      { kind: "input", text },
      { kind: "output", text: outputs[i]! },
    ]);
    await pump(
      source.map(({ kind, text }, i) =>
        provider === "gemini"
          ? {
              serverContent: {
                [kind === "input"
                  ? "inputTranscription"
                  : "outputTranscription"]: { text },
              },
            }
          : {
              type:
                kind === "input"
                  ? "session.input_transcript.delta"
                  : "session.output_transcript.delta",
              event_id: `quota-${i}`,
              delta: text,
              start_ms: i * 1000,
              end_ms: i * 1000 + 500,
            }
      ),
      true
    );
    await pump();
    const events = received.filter(
      (f): f is Extract<ServerMessage, { type: "conversation_event" }> =>
        f.type === "conversation_event" &&
        [
          "input_fragment",
          "unassigned_input_fragment",
          "output_transcript",
        ].includes(f.event.kind)
    );
    expect(events.map((f) => ("text" in f.event ? f.event.text : ""))).toEqual(
      source.map((f) => f.text)
    );
    const prefix = result.rows.map(
      (r: any) => JSON.parse(r.payload).event.text
    ) as string[];
    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix.length).toBeLessThan(source.length);
    expect(events.filter((f) => f.retention === "unsaved")).toHaveLength(
      source.length - prefix.length
    );
    // Expand the existing finite reading window; hidden rows are not lost history.
    for (let n = 0; n < 5; n++) {
      const earlier = [
        ...s.element.querySelectorAll<HTMLElement>("button,[role=button]"),
      ].find((b) => (b.textContent ?? "").includes("earlier message"));
      if (!earlier) break;
      flushSync(() => earlier.click());
    }
    const rendered = () => s.element.textContent!;
    for (const item of source) expect(rendered()).toContain(item.text);
    expect([...s.element.querySelectorAll('[data-transcript-qualifiers="generated"]')].some(q=>q.getAttribute("aria-label")?.includes("unsaved")),"UNSAVED_REPLY_QUALIFIER").toBe(true);
    const offsets = source.map((item) => rendered().indexOf(item.text));
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(s.ui.connection.conversation.state.getState().micOn).toBe(false);
    expect(rendered()).toContain("could not be saved");
    const profile = s.ui.connection.conversation.state.getState().profile!;
    const stale = {
      type: "conversation_event" as const,
      conversationId: profile.conversationId,
      epoch: profile.epoch + 1,
      retention: "unsaved" as const,
      event: {
        kind: "unassigned_input_fragment" as const,
        sequence: 999,
        text: "Foreign epoch must stay absent.",
        timing: { kind: "unavailable" as const },
      },
    };
    s.socket.deliver(stale);
    expect(rendered()).not.toContain(stale.event.text);
    s.ui.connection.conversation.leave();
    s.socket.deliver({
      ...stale,
      epoch: profile.epoch,
      event: { ...stale.event, text: "Stopped callback must stay absent." },
    });
    expect(rendered()).not.toContain("Stopped callback must stay absent.");
    const selected=s.ui.stores.chat.getState().activeSessionId!;
    flushSync(()=>s.socket.deliver({type:"error",code:"SESSION_NOT_FOUND",sessionId:selected,message:"This conversation is not available on this host. Your observed text is kept locally."}));
    // Leave adopts the host-only UI target and starts that chat's normal
    // finite reading window. Reveal its earlier rows before checking all text.
    for(let n=0;n<5;n++){
      const earlier=[...s.element.querySelectorAll<HTMLElement>('button,[role="button"]')].find(b=>b.textContent?.includes("earlier message"));
      if(!earlier)break;flushSync(()=>earlier.click());
    }

    for(const item of source) expect(rendered(),"MISSING_HISTORY_PRESERVES_OBSERVED_TAIL").toContain(item.text);
    flushSync(()=>s.ui.stores.chat.getState().setActiveSession("other-chat"));
    expect(rendered()).not.toContain(source.at(-1)!.text);
    flushSync(()=>s.ui.stores.chat.getState().setActiveSession(selected));
    expect(rendered()).toContain(source.at(-1)!.text);


    expect(result.tasks).toBe(0);
    s.close();
    s = await view(ctx, `dialogue:${owner}`, owner);
    cursor = 0;
    await pump([], false, true);
    s.ui.connection.conversation.loadDialogue(`dialogue:${owner}`);
    await expect
      .poll(async () => {
        await pump();
        return rendered();
      })
      .toContain(prefix[0]!);
    for (const text of prefix) expect(rendered()).toContain(text);
    expect(rendered()).not.toContain(source.at(-1)!.text);
    expect(result.tasks).toBe(0);
    expect(s.ui.connection.conversation.state.getState().micOn).toBe(false);
  });


for (const provider of ["gemini", "gpt"] as const) for (const failure of ["quota", "pressure"] as const)
 test(`${provider}: contiguous recognition splits the saved prefix from ${failure} tail`,async(ctx)=>{
  microphone(ctx);
  const fixture=await commands.conversationServer({op:"start",durable:true,provider}) as {id:string};
  ctx.onTestFinished(async()=>{await commands.conversationServer({op:"stop",id:fixture.id});});
  const s=await view(ctx,null);let cursor=0,result:any;const received:ServerMessage[]=[];
  const pump=async(providerFrames:unknown[]=[],fault=false)=>{
   const client=s.socket.sent.slice(cursor).map(b=>JSON.parse(String(b.data)));cursor=s.socket.sent.length;
   result=await commands.conversationServer({op:"step",id:fixture.id,client,provider:providerFrames,...(fault ? {[failure]:true} : {})});
   for(const frame of result.frames){received.push(frame);s.socket.deliver(frame);}
  };
  await pump();s.ui.connection.conversation.enter();
  await expect.poll(async()=>{await pump();return s.ui.connection.conversation.state.getState().profile;}).not.toBeNull();
  s.ui.connection.conversation.start();await expect.poll(()=>s.socket.frames("conversation_audio").length).toBeGreaterThan(0);await pump();
  const audio=result.sent.find((m:any)=>m.type==="session.input_audio.append");
  const input=(i:number)=>provider==="gemini" ? {serverContent:{inputTranscription:{text:`Observation ${i}: ${failure==="quota" ? "mast ".repeat(390) : "mast."}`}}} : {type:"session.input_transcript.delta",event_id:`split-${i}`,client_event_id:audio.event_id,delta:`Observation ${i}: ${failure==="quota" ? "mast ".repeat(390) : "mast."}`,start_ms:i*1000,end_ms:i*1000+500};
  await pump([input(0)]);
  await pump(Array.from({length:failure==="quota"?30:270},(_,i)=>input(i+1)),true);
  const events=received.filter((f):f is Extract<ServerMessage,{type:"conversation_event"}>=>f.type==="conversation_event"&&(f.event.kind==="input_fragment"||f.event.kind==="unassigned_input_fragment"));
  const rows=transcriptTimelineFor(s.ui.stores.chat).state.getState().entries.filter(e=>e.kind==="recognition");
  expect(rows).toHaveLength(2);
  expect(rows.map(e=>!!e.fragments[0]!.unsaved)).toEqual([false,true]);
  const qualifiers=[...s.element.querySelectorAll<HTMLButtonElement>('[data-transcript-qualifiers="recognized"]')];
  expect(qualifiers).toHaveLength(2);
  expect(qualifiers[0]!.getAttribute("aria-label")).not.toContain("unsaved");
  expect(qualifiers[1]!.getAttribute("aria-label"),"UNSAVED_ROW_QUALIFIER").toContain("unsaved");
  expect(qualifiers[1]!.querySelectorAll("svg").length).toBeGreaterThan(qualifiers[0]!.querySelectorAll("svg").length);

  expect(rows.flatMap(e=>e.fragments.map(f=>f.text))).toEqual(events.map(f=>"text" in f.event ? f.event.text : ""));
  expect(result.rows).toHaveLength(events.filter(f=>f.retention!=="unsaved").length);
  expect(s.ui.connection.conversation.state.getState().micOn).toBe(false);
  const errors=received.filter((f):f is Extract<ServerMessage,{type:"error"}>=>f.type==="error"&&f.code.startsWith("DIALOGUE_"));
  expect(errors.map(f=>f.code)).toContain(failure==="quota"?"DIALOGUE_STORAGE":"DIALOGUE_PENDING_PRESSURE");
  if(failure==="pressure"){
   expect(s.element.textContent).toContain("arriving faster than it can be saved");
   expect(errors.some(f=>f.code==="DIALOGUE_STORAGE")).toBe(false);
   expect(result.rows).toHaveLength(257); // initial saved observation plus the finite pending queue
   expect(events.at(-1)!.retention).toBe("unsaved");
  }else expect(s.element.textContent).toContain("could not be saved");
  expect(result.tasks).toBe(0);s.ui.connection.conversation.leave();await pump();
  expect(s.ui.connection.conversation.state.getState().recognition.some(f=>f.unsaved)).toBe(true);
  const before=s.socket.sent.length;
  s.socket.deliver({type:"server_hello",protocolRev:5,principalKey:"penelope",capabilities:{liveConversation:true,conversationPause:true,sessionDialogue:true}});
  expect(s.ui.connection.conversation.state.getState().recognition).toEqual([]);
  expect(s.ui.connection.conversation.state.getState().outputs).toEqual([]);
  expect(s.ui.connection.conversation.state.getState().dialogue).toEqual({});
  expect(s.socket.sent.slice(before).map(b=>JSON.parse(String(b.data))).filter(f=>f.type.startsWith("conversation_"))).toEqual([]);

 });


for(const provider of ["gemini","gpt"] as const)test(`${provider}: task outcome storage failure cannot close ahead of observed dialogue callbacks`,async ctx=>{
 microphone(ctx);const fixture=await commands.conversationServer({op:"start",durable:true,provider}) as {id:string};ctx.onTestFinished(async()=>{await commands.conversationServer({op:"stop",id:fixture.id});});
 const s=await view(ctx,null);let cursor=0,result:any;const received:ServerMessage[]=[];
 const pump=async(providerFrames:unknown[]=[],finish=false)=>{
  const client=s.socket.sent.slice(cursor).map(b=>JSON.parse(String(b.data)));cursor=s.socket.sent.length;
  result=await commands.conversationServer({op:"step",id:fixture.id,client,provider:providerFrames,...(finish?{quota:true,finishDuring:2,resultText:"Mast ready. ".repeat(360).slice(0,4000)}:{})});
  for(const f of result.frames){received.push(f);s.socket.deliver(f);}
 };
 await pump();s.ui.connection.conversation.enter();await expect.poll(async()=>{await pump();return s.ui.connection.conversation.state.getState().profile;}).not.toBeNull();s.ui.connection.conversation.start();await expect.poll(()=>s.socket.frames("conversation_audio").length).toBeGreaterThan(0);await pump();
 await pump(provider==="gemini"?[{serverContent:{inputTranscription:{text:"Research the mast."}}},{toolCall:{functionCalls:[{id:"mast-research",name:"host_task"}]}}]:[{type:"session.input_transcript.delta",event_id:"task-primer",delta:"Research the mast.",start_ms:0,end_ms:100},{type:"session.delegation.created",event_id:"task-native",offset_ms:100,delegation:{id:"mast-research",type:"delegation",target:"client"}}]);
 await expect.poll(async()=>{await pump();return result.tasks;}).toBe(1);
 const texts=Array.from({length:30},(_,i)=>`Tail ${i}: ${"mast ".repeat(390)}`);
 await pump(texts.map((text,i)=>provider==="gemini"?{serverContent:{inputTranscription:{text}}}:{type:"session.input_transcript.delta",event_id:`task-tail-${i}`,delta:text,start_ms:1000+i*1000,end_ms:1500+i*1000}),true);
 const textEvents=received.filter((f):f is Extract<ServerMessage,{type:"conversation_event"}>=>f.type==="conversation_event"&&(f.event.kind==="input_fragment"||f.event.kind==="unassigned_input_fragment"));
 expect(textEvents.map(f=>"text"in f.event?f.event.text:"").filter(t=>t.startsWith("Tail ")),"TASK_FAILURE_DRAINS_OBSERVED_DIALOGUE").toEqual(texts);
 expect(s.ui.connection.conversation.state.getState().micOn).toBe(false);expect(result.tasks).toBe(1);
 expect(received.filter(f=>f.type==="error" && f.code==="DIALOGUE_STORAGE"),"ONE_STORAGE_FAILURE_EPISODE").toHaveLength(1);
 const rawVoice=result.rows.map((r:any)=>JSON.parse(r.payload)).filter((e:any)=>e.kind==="voice").map((e:any)=>e.event.text);
 const saved=textEvents.filter(f=>f.retention!=="unsaved").map(f=>"text"in f.event?f.event.text:"");expect(rawVoice).toEqual(saved);
 s.ui.connection.conversation.leave();await pump();
});


for(const quota of [false,true])test(`typed result after Leave retains its full native answer with position-only qualification quota=${quota}`,async ctx=>{
 microphone(ctx);const fixture=await commands.conversationServer({op:"start",durable:true,provider:"gpt"}) as {id:string};
 ctx.onTestFinished(async()=>{await commands.conversationServer({op:"stop",id:fixture.id});});
 let s=await view(ctx,null),cursor=0,result:any,completed=0;
 const pump=async(extra:Record<string,unknown>={})=>{const client=s.socket.sent.slice(cursor).map(b=>JSON.parse(String(b.data)));cursor=s.socket.sent.length;result=await commands.conversationServer({op:"step",id:fixture.id,client,provider:[],...extra} as any);for(const frame of result.frames){if(frame.type==="result")completed++;s.socket.deliver(frame);}return result;};
 await pump();s.ui.connection.conversation.enter();await expect.poll(async()=>{await pump();return s.ui.connection.conversation.state.getState().profile;}).not.toBeNull();
 s.ui.connection.conversation.start();await expect.poll(()=>s.ui.connection.conversation.state.getState().micOn).toBe(true);await expect.poll(()=>s.socket.frames("conversation_audio").length).toBeGreaterThan(0);await pump();
 await pump({provider:[{type:"session.input_transcript.delta",event_id:"prime-input",delta:"Research the mast.",start_ms:0,end_ms:100},{type:"session.delegation.created",event_id:"prime-task",offset_ms:100,delegation:{id:"mast-research",type:"delegation",target:"client"}}]});
 await expect.poll(async()=>{await pump();return result.tasks;}).toBe(1);await pump({release:true});await expect.poll(async()=>{await pump();return completed;}).toBe(1);
 s.ui.connection.conversation.leave();await pump();
 s.socket.send(JSON.stringify({type:"chat_message",sessionId:"odysseus-ithaca",text:"Read the mast note.",providerId:"fake"}));
 await expect.poll(async()=>{await pump();return result.tasks;}).toBe(2);
 const answer=quota?"The bronze owl marks departure. ".repeat(3000):"The bronze owl marks departure.";
 await pump({release:true,multipart:true,backendTailQuota:quota,resultText:answer});
 await expect.poll(async()=>{await pump();return completed;}).toBe(2);
 const raw=result.rows.map((r:any)=>JSON.parse(r.payload));
 const retained=raw.filter((r:any)=>r.kind==="backend").map((r:any)=>r.text).join("");
 const full="The departure signal is a bronze owl.The mast is ready. "+answer;
 expect(full.startsWith(retained),"RAW_DB_IS_AN_EXACT_PREFIX").toBe(true);
 if(quota)expect(retained.length,"FINAL_BACKEND_APPEND_ACTUALLY_FAILED").toBeLessThan(full.length);else expect(retained).toBe(full);
 s.close();s=await view(ctx,"odysseus-ithaca");cursor=0;await pump({restart:true});s.socket.send(JSON.stringify({type:"session_resume",sessionId:"odysseus-ithaca"}));
 await expect.poll(async()=>{await pump();return s.element.textContent;}).toContain("The bronze owl marks departure.");
 const messages=s.ui.stores.chat.getState().buffers["odysseus-ithaca"]!.messages;
 expect(messages.filter(m=>m.role==="assistant").at(-1)!.content,"NATIVE_FINAL_ANSWER_IS_COMPLETE").toBe("The mast is ready. "+answer);
 const notices=[...s.element.querySelectorAll("p")].filter(e=>e.textContent==="Original discussion position unknown.");
 expect(notices,"BACKEND_TAIL_POSITION_ONLY").toHaveLength(quota?1:0);
 expect(s.element.textContent).not.toContain("Voice history may be incomplete");
 expect(s.element.querySelector('[data-transcript-qualifiers][aria-label*="unsaved"]')).toBeNull();
});


function r6Date(ctx:TestContext){vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-07-12T12:00:00Z"));ctx.onTestFinished(()=>{vi.useRealTimers();});}

for(const provider of ["gemini","gpt"] as const)for(const legacy of [false,true])test(`R6 ${provider}: typed-only chat has no invented voice history legacy=${legacy}`,async ctx=>{
 r6Date(ctx);const fixture=await commands.conversationServer({op:"start",durable:true,provider}) as {id:string};ctx.onTestFinished(async()=>{await commands.conversationServer({op:"stop",id:fixture.id});});
 const s=await view(ctx,null);let cursor=0,result:any,completed=0;
 const pump=async(extra:Record<string,unknown>={})=>{const client=s.socket.sent.slice(cursor).map(b=>JSON.parse(String(b.data)));cursor=s.socket.sent.length;result=await commands.conversationServer({op:"step",id:fixture.id,client,provider:[],...extra} as any);for(const f of result.frames){if(f.type==="result")completed++;s.socket.deliver(f);}return result;};
 await pump();s.socket.send(JSON.stringify({type:"chat_message",text:"Read the mast note.",providerId:"fake"}));await expect.poll(async()=>{await pump();return result.tasks;}).toBe(1);await pump({release:true});await expect.poll(async()=>{await pump();return completed;}).toBe(1);
 if(legacy)await pump({seedLegacyVoice:true});s.ui.connection.conversation.loadDialogue("odysseus-ithaca");await pump();
 const body=s.element.textContent??"";
 if(legacy){expect(body,"GENUINE_PRE_RETENTION_VOICE_IS_QUALIFIED").toContain("Earlier spoken dialogue was not saved.");expect(body).not.toContain("Show latest conversation");}
 else{expect(body,"TYPED_ONLY_NO_LEGACY_NOTICE").not.toContain("Earlier spoken dialogue was not saved.");expect(body,"TYPED_ONLY_NO_LATEST_VOICE_BUTTON").not.toContain("Show latest conversation");}
 expect(result.rows).toEqual([]);expect(result.tasks).toBe(1);
 await page.screenshot({element:s.element,path:`../../.vitest-attachments/durable-dialogue/r6-typed-${provider}-legacy-${legacy}.png`});
});

for(const provider of ["gemini","gpt"] as const)test(`R6 ${provider}: first voice mid typed answer keeps true offsets and healthy active coverage`,async ctx=>{
 r6Date(ctx);const fixture=await commands.conversationServer({op:"start",durable:true,provider}) as {id:string};ctx.onTestFinished(async()=>{await commands.conversationServer({op:"stop",id:fixture.id});});
 let s=await view(ctx,null),cursor=0,result:any,completed=0;
 const pump=async(extra:Record<string,unknown>={})=>{const client=s.socket.sent.slice(cursor).map(b=>JSON.parse(String(b.data)));cursor=s.socket.sent.length;result=await commands.conversationServer({op:"step",id:fixture.id,client,provider:[],...extra} as any);for(const f of result.frames){if(f.type==="result")completed++;s.socket.deliver(f);}return result;};
 await pump();s.socket.send(JSON.stringify({type:"chat_message",text:"Read the mast note.",providerId:"fake"}));await expect.poll(async()=>{await pump();return result.tasks;}).toBe(1);await pump({backendPrefix:"Part one. "});
 await expect.poll(()=>s.element.textContent).toContain("Part one.");s.ui.connection.conversation.enter();await expect.poll(async()=>{await pump();return s.ui.connection.conversation.state.getState().profile;}).not.toBeNull();
 s.ui.connection.conversation.loadDialogue("odysseus-ithaca");await pump();
 expect(s.ui.connection.conversation.state.getState().dialogue["odysseus-ithaca"]!.coverage,"HEALTHY_ACTIVE_READ_WITHOUT_NEXT_DELTA").toBe("complete");
 expect(s.element.textContent).not.toContain("Voice history may be incomplete");expect(s.element.textContent).not.toContain("Earlier spoken dialogue was not saved");
 await pump({release:true,resultText:"Part two."});await expect.poll(async()=>{await pump();return completed;}).toBe(1);
 const ranges=result.rows.map((r:any)=>JSON.parse(r.payload)).filter((r:any)=>r.kind==="backend");expect(ranges,"NO_PRE_OWNER_BACKFILL").toHaveLength(1);expect(ranges[0],"MIDTURN_ACTUAL_HOST_OFFSET").toMatchObject({start:10,end:19,text:"Part two."});
 s.ui.connection.conversation.leave();await pump();s.close();s=await view(ctx,"odysseus-ithaca");cursor=0;await pump({restart:true});s.socket.send(JSON.stringify({type:"session_resume",sessionId:"odysseus-ithaca"}));await expect.poll(async()=>{await pump();return s.element.textContent;}).toContain("Part two.");
 const answer=s.ui.stores.chat.getState().buffers["odysseus-ithaca"]!.messages.find(m=>m.role==="assistant")!;expect(answer.content,"FULL_NATIVE_PREFIX_AND_SUFFIX").toBe("Part one. Part two.");
 await page.screenshot({element:s.element,path:`../../.vitest-attachments/durable-dialogue/r6-midturn-${provider}.png`});
 expect(s.element.textContent).not.toContain("Earlier spoken dialogue was not saved");expect(s.element.textContent).not.toContain("Voice history may be incomplete");expect(s.element.querySelector('[data-transcript-qualifiers][aria-label*="unsaved"]')).toBeNull();
});


for(const provider of ["gemini","gpt"] as const)test(`R7 ${provider}: device takeover retains ordered evidence without false incomplete history`,async ctx=>{
 r6Date(ctx);microphone(ctx);const fixture=await commands.conversationServer({op:"start",durable:true,provider}) as {id:string};ctx.onTestFinished(async()=>{await commands.conversationServer({op:"stop",id:fixture.id});});
 let s=await view(ctx,null),cursor=0,result:any,completed=0;
 const pump=async(extra:Record<string,unknown>={})=>{const client=s.socket.sent.slice(cursor).map(b=>JSON.parse(String(b.data)));cursor=s.socket.sent.length;result=await commands.conversationServer({op:"step",id:fixture.id,client,provider:[],...extra} as any);for(const f of result.frames){if(f.type==="result")completed++;s.socket.deliver(f);}return result;};
 const input=(n:number,text:string)=>provider==="gemini"?{serverContent:{inputTranscription:{text}}}:{type:"session.input_transcript.delta",event_id:`takeover-${n}`,delta:text,start_ms:n*100,end_ms:n*100+50};
 await pump();s.socket.send(JSON.stringify({type:"chat_message",text:"Read the mast note.",providerId:"fake"}));await expect.poll(async()=>{await pump();return result.tasks;}).toBe(1);await pump({release:true});await expect.poll(async()=>{await pump();return completed;}).toBe(1);
 s.ui.connection.conversation.enter();await expect.poll(async()=>{await pump();return s.ui.connection.conversation.state.getState().profile;}).not.toBeNull();s.ui.connection.conversation.start();await expect.poll(()=>s.socket.frames("conversation_audio").length).toBeGreaterThan(0);await pump();
 const first=s.ui.connection.conversation.state.getState().profile!;await pump({provider:[input(0,"Check the mast. "),input(1,"Check the sail. ")]});
 // The second device retained the same authorized native handle. Its own
 // SDK resume creates a fresh opening token; no admission guard is bypassed.
 s.close();s=await view(ctx,"odysseus-ithaca");cursor=0;await pump({takeover:true});
 flushSync(()=>s.ui.connection.conversation.state.setState({active:true,sessionId:"odysseus-ithaca",profile:first,disclosureOpen:false}));s.ui.connection.conversation.resume();
 await expect.poll(async()=>{await pump();return s.ui.connection.conversation.state.getState().profile?.epoch;}).toBe(2);
 s.ui.connection.conversation.loadDialogue("odysseus-ithaca");await pump();
 expect(s.ui.connection.conversation.state.getState().dialogue["odysseus-ithaca"]!.coverage,"DEVICE_TAKEOVER_READ_COMPLETE").toBe("complete");expect(s.element.textContent,"DEVICE_TAKEOVER_NO_FALSE_NOTICE").not.toContain("Voice history may be incomplete");
 s.ui.connection.conversation.start();await expect.poll(()=>s.ui.connection.conversation.state.getState().micOn).toBe(true);await pump();await pump({provider:[input(2,"The crew is ready.")]});
 const voice=result.rows.map((r:any)=>JSON.parse(r.payload)).filter((e:any)=>e.kind==="voice");expect(voice.map((e:any)=>e.event.text)).toEqual(["Check the mast. ","Check the sail. ","The crew is ready."]);expect(voice.map((e:any)=>e.epoch)).toEqual([1,1,2]);
 s.ui.connection.conversation.leave();await pump();s.close();s=await view(ctx,"odysseus-ithaca");cursor=0;await pump({restart:true});s.socket.send(JSON.stringify({type:"session_resume",sessionId:"odysseus-ithaca"}));await expect.poll(async()=>{await pump();return s.element.textContent;}).toContain("The crew is ready.");
 for(const text of ["Check the mast.","Check the sail.","The crew is ready."])expect(s.element.textContent).toContain(text);expect(s.element.textContent).not.toContain("Voice history may be incomplete");expect(result.tasks).toBe(1);
 await page.screenshot({element:s.element,path:`../../.vitest-attachments/durable-dialogue/r7-takeover-${provider}.png`});
});


for(const provider of ["gemini","gpt"] as const)test(`R8 ${provider}: simultaneous live conversations for one chat have no false incomplete notice`,async ctx=>{
 r6Date(ctx);microphone(ctx);const fixture=await commands.conversationServer({op:"start",durable:true,provider}) as {id:string};ctx.onTestFinished(async()=>{await commands.conversationServer({op:"stop",id:fixture.id});});
 let s=await view(ctx,null),cursor=0,result:any,completed=0;
 const pump=async(extra:Record<string,unknown>={})=>{const client=s.socket.sent.slice(cursor).map(b=>JSON.parse(String(b.data)));cursor=s.socket.sent.length;result=await commands.conversationServer({op:"step",id:fixture.id,client,provider:[],...extra} as any);for(const f of result.frames){if(f.type==="result")completed++;s.socket.deliver(f);}return result;};
 await pump();s.socket.send(JSON.stringify({type:"chat_message",text:"Read the mast note.",providerId:"fake"}));await expect.poll(async()=>{await pump();return result.tasks;}).toBe(1);await pump({release:true});await expect.poll(async()=>{await pump();return completed;}).toBe(1);
 s.ui.connection.conversation.enter();await expect.poll(async()=>{await pump({parallelStarts:true});return s.ui.connection.conversation.state.getState().profile;}).not.toBeNull();
 expect(result.conversations.filter((r:any)=>r.closed===0),"TWO_REAL_OPEN_CONVERSATIONS "+JSON.stringify(result.parallelFrames)).toHaveLength(2);
 s.ui.connection.conversation.loadDialogue("odysseus-ithaca");await pump();
 expect(result.owners.map((r:any)=>r.coverage),"CONCURRENT_CHAT_DB_COMPLETE").toEqual(["complete"]);
 expect(s.ui.connection.conversation.state.getState().dialogue["odysseus-ithaca"]!.coverage,"CONCURRENT_CHAT_READ_COMPLETE").toBe("complete");expect(s.element.textContent,"CONCURRENT_CHAT_NO_FALSE_NOTICE").not.toContain("Voice history may be incomplete");
 await pump({provider:[provider==="gemini"?{serverContent:{inputTranscription:{text:"The mast is ready."}}}:{type:"session.input_transcript.delta",event_id:"parallel-input",delta:"The mast is ready.",start_ms:0,end_ms:100}]});s.ui.connection.conversation.loadDialogue("odysseus-ithaca");await pump();
 const retained=result.rows.map((r:any)=>JSON.parse(r.payload)).filter((e:any)=>e.kind==="voice");expect(retained.map((e:any)=>e.event.text)).toEqual(["The mast is ready."]);expect(retained[0].providerId).toBe(provider==="gemini"?"gemini-live":"gpt-live");await expect.poll(()=>s.element.textContent).toContain("The mast is ready.");
 await page.screenshot({element:s.element,path:`../../.vitest-attachments/durable-dialogue/r8-concurrent-${provider}.png`});
 s.ui.connection.conversation.leave();await pump({parallelLeave:true});s.close();s=await view(ctx,"odysseus-ithaca");cursor=0;await pump({restart:true});s.socket.send(JSON.stringify({type:"session_resume",sessionId:"odysseus-ithaca"}));await expect.poll(async()=>{await pump();return s.element.textContent;}).toContain("The mast is ready.");expect(s.element.textContent).not.toContain("Voice history may be incomplete");expect(result.tasks).toBe(1);
});
