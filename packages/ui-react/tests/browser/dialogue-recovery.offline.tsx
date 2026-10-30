/// <reference types="@vitest/browser-playwright" />
import { test, expect, beforeAll, afterAll, type TestContext } from "vitest";
import { commands } from "vitest/browser";
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
      s.ui.stores.chat.getState().setActiveSession("other-chat");
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
 });
