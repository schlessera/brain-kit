/// <reference types="@vitest/browser-playwright" />
import { test, expect, beforeAll, afterAll, type TestContext } from "vitest";
import { commands } from "vitest/browser";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import { createBrainUiRoot } from "../../src/root.js";
import { BrainUiProvider } from "../../src/root-context.js";
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

for (const provider of ["gemini","gpt"] as const)
test(`${provider}: native indeterminate drain stops the browser without inventing saved or unsaved text`,async ctx=>{
  microphone(ctx);
  const fixture=await commands.conversationServer({op:"start",durable:true,provider}) as {id:string};
  ctx.onTestFinished(async()=>{await commands.conversationServer({op:"stop",id:fixture.id});});
  const s=await view(ctx,null);let cursor=0,result:any;const received:ServerMessage[]=[];
  const pump=async(extra:Record<string,unknown>={})=>{
    const client=s.socket.sent.slice(cursor).map(b=>JSON.parse(String(b.data)));cursor=s.socket.sent.length;
    result=await commands.conversationServer({op:"step",id:fixture.id,client,provider:[],...extra} as any);
    for(const f of result.frames){received.push(f);s.socket.deliver(f);}return result;
  };
  await pump();s.ui.connection.conversation.enter();
  await pump();expect(result.providerOpens,"ENTER_SENDS_NOTHING").toBe(0);
  s.ui.connection.conversation.start();
  await expect.poll(async()=>{await pump();return s.ui.connection.conversation.state.getState().profile;}).not.toBeNull();
  s.ui.connection.conversation.start();
  await expect.poll(()=>s.socket.frames("conversation_audio").length).toBeGreaterThan(0);
  await pump();
  const input=(i:number,text:string)=>provider==="gemini"?{serverContent:{inputTranscription:{text}}}:{type:"session.input_transcript.delta",event_id:`drain-${i}`,delta:text,start_ms:i*1000,end_ms:i*1000+500};
  await pump({provider:[input(0,"The saved mast prefix.")]});
  expect(result.rows).toHaveLength(1);
  const focused=s.element.querySelector<HTMLElement>('[data-transcript-qualifiers="recognized"]');
  focused?.focus();
  await pump({holdWrites:true,provider:[input(1,"The indeterminate sail tail.")]});
  expect(result.rows).toHaveLength(1);
  expect(s.element.textContent,"UNRESOLVED_TEXT_IS_WITHHELD").not.toContain("The indeterminate sail tail.");
  await pump({expireWrites:true});
  expect(received.some(f=>f.type==="conversation_closed"),"FAILED_EPOCH_HAS_VISIBLE_TERMINAL").toBe(true);
  await expect.poll(()=>s.ui.connection.conversation.state.getState().micOn).toBe(false);
  expect(s.ui.connection.conversation.state.getState().micOn).toBe(false);
  expect(s.element.textContent).toContain("persistence could not be confirmed");
  expect(s.element.textContent).toContain("Voice history may be incomplete");
  expect(received.filter(f=>f.type==="conversation_event"&&f.retention==="unsaved"),"TIMEOUT_IS_NOT_CONFIRMED_UNSAVED").toEqual([]);
  expect(s.element.textContent).toContain("The saved mast prefix.");
  expect(result.tasks).toBe(0);
  const afterTerminal=received.length;
  s.ui.connection.conversation.leave();await pump();
  await pump({releaseWrites:true});
  expect(result.rows).toHaveLength(2);
  const late=received.slice(afterTerminal);
  expect(late.filter(f=>f.type==="conversation_event"),"LATE_NATIVE_COMMIT_HAS_NO_LIVE_EVENT").toEqual([]);
  for(const frame of late) if(frame.type==="dialogue_history") expect(frame.requestId,"LATE_HISTORY_IS_AN_AUTHORIZED_READ_REPLY").toBeTruthy();
  expect(result.tasks).toBe(0);
  // A revoked principal clears prior text and cannot cause recovery/work replay.
  s.socket.deliver({type:"server_hello",protocolRev:5,principalKey:"penelope",capabilities:{liveConversation:true,conversationPause:true,sessionDialogue:true}});
  expect(s.ui.connection.conversation.state.getState().recognition).toEqual([]);
  expect(s.ui.connection.conversation.state.getState().dialogue).toEqual({});
});
