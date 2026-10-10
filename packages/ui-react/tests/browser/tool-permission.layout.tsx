import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import type { ClientMessage } from "@schlessera/brain-ui-sdk/protocol";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { SubagentView } from "../../src/components/chat/subagent-view.js";
import { activeChat, useChatStore } from "../../src/stores/chat-store.js";
import { replyToToolApproval } from "../../src/lib/tool-approval.js";

let renderer: Root | undefined, root: BrainUiRoot | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement;
let viewport: { width: number; height: number }, outer: { width: number; height: number }, themeBefore: string | undefined;
beforeEach(() => { viewport = { width: innerWidth, height: innerHeight }; themeBefore = document.documentElement.dataset.theme; });
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());
afterEach(async () => { if (renderer) flushSync(() => renderer!.unmount()); root?.dispose(); host?.remove(); renderer = undefined; root = undefined; host = undefined;
  document.documentElement.dataset.theme = themeBefore; await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
});
const target="/tmp/ithaca/"+"Scylla".repeat(30)+"/crossing.md";
const input={file_path:target,old_string:"Risk six men.\nThe path crosses the strait.",new_string:"Keep the crossing visible.\nThe path is explicit."};
const command="rm -rf knowledge/"+"Scylla".repeat(30);
for(const width of [320,1280])for(const theme of ["dark","light"])for(const location of ["main","subagent"] as const){
  test(`${theme} ${width} ${location}: actual permission cards retain targets, diff, risks, 44px decisions and focus handoff`,async()=>{
    outer=await commands.formViewport(width,900);await page.viewport(width,900);document.documentElement.dataset.theme=theme;
    const requests:string[]=[];root=createBrainUiRoot({storage:null,request:async url=>{requests.push(String(url));throw new Error("no permission lookup");}});root.stores.ui.getState().setSingleKeyShortcuts(true);
    root.stores.chat.getState().requestToolApproval(null,"edit-original","Edit",input,undefined,"tool");
    root.stores.chat.getState().requestToolApproval(null,"command-original","Bash",{command},"Deletes the supplied crossing notes.","command");
    const parent={spanId:"permission-agent",runId:"permission-run",kind:"subagent" as const,origin:"session" as const,name:"Agent",startedAt:0};
    const children=["edit-original","command-original"].map(spanId=>({...parent,spanId,parentSpanId:parent.spanId,kind:"tool" as const}));
    root.stores.activity.setState({spans:{[parent.runId]:Object.fromEntries([parent,...children].map(span=>[span.spanId,span]))},spanRun:Object.fromEntries([parent,...children].map(span=>[span.spanId,span.runId]))});
    const replies:ClientMessage[]=[];const send=(message:ClientMessage)=>{replies.push(message);return true;};const decide=(id:string,approved:boolean,always?:boolean)=>replyToToolApproval(root!,null,send,id,approved,always);
    function View(){const calls=useChatStore(s=>activeChat(s).messages.at(-1)?.toolCalls??[]);return <>{location==="main"?<ToolCallTimeline live toolCalls={calls} onApproval={decide}/>:<SubagentView spanId={parent.spanId} onApproval={decide}/>}<textarea data-composer aria-label="continue"/></>;}
    host=document.createElement("div");host.style.cssText=`width:${Math.min(width,720)}px;background:var(--bk-color-canvas);color:var(--bk-color-ink)`;document.body.append(host);renderer=createRoot(host);
    flushSync(()=>renderer!.render(<BrainUiProvider root={root}><View/></BrainUiProvider>));
    const cards=[...host.querySelectorAll<HTMLElement>('[data-kit-approval-card]')];expect(cards).toHaveLength(2);
    expect(input.old_string.length).toBeGreaterThan(20);expect(input.new_string.length).toBeGreaterThan(20);
    expect(cards[0]!.textContent).toContain(target);expect(cards[0]!.textContent).toContain("Risk six men.");expect(cards[0]!.textContent).toContain("Keep the crossing visible.");expect(cards[0]!.textContent).toContain("writes outside the brain repo");
    expect(cards[1]!.textContent).toContain(command);expect(cards[1]!.textContent).toContain("removes files recursively");expect(cards[1]!.textContent).toContain("Deletes the supplied crossing notes.");
    expect(cards[0]!.textContent).toContain("Always allow");expect(cards[1]!.textContent).not.toContain("Always allow");
    await expect.poll(() => cards.every(card => {
      const box = card.getBoundingClientRect();
      for (let parent = card.parentElement; parent && parent !== host; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowY !== "hidden") continue;
        const boundary = parent.getBoundingClientRect();
        if (box.bottom > boundary.bottom + 1 || box.top < boundary.top - 1) return false;
      }
      return true;
    }), { message: "all decisions are visible after expansion" }).toBe(true);
    for(const card of cards){expect(card.scrollWidth,"complete permission record fits").toBeLessThanOrEqual(card.clientWidth+1);for(const button of card.querySelectorAll<HTMLElement>('[role="button"]'))expect(button.getBoundingClientRect().height,"permission decision target").toBeGreaterThanOrEqual(44);}
    expect(host.querySelectorAll('[role="button"][aria-label="Allow"]')).toHaveLength(2);
    expect(host.querySelectorAll('[role="button"][aria-label="Deny"]')).toHaveLength(2);
    expect(requests).toEqual([]);
    await commands.formViewport(width,Math.ceil(host.scrollHeight)+32);await page.viewport(width,Math.ceil(host.scrollHeight)+32);await page.screenshot({element:host,path:`../../.vitest-attachments/tool-permission/${location}-${theme}-${width}.png`});
    const scopes=[...host.querySelectorAll<HTMLElement>('[data-approval-card]')];expect(scopes).toHaveLength(2);
    scopes[0]!.focus();await userEvent.keyboard("a");
    await expect.poll(()=>replies.length).toBe(1);expect(replies[0]).toEqual({type:"tool_approval",toolUseId:"edit-original",channel:"card"});
    const acceptedEdit=activeChat(root.stores.chat.getState()).messages.flatMap(message=>message.toolCalls).find(tool=>tool.id==="edit-original");
    expect(acceptedEdit?.status,"accepted edit settles in shared request state").toBe("approved");
    await expect.poll(()=>document.activeElement).toBe(scopes[1]);await userEvent.keyboard("d");
    await expect.poll(()=>replies.length).toBe(2);expect(replies[1]).toEqual({type:"tool_denial",toolUseId:"command-original",message:"Denied by user",channel:"card"});
    await expect.poll(()=>document.activeElement).toBe(host!.querySelector("textarea"));expect(host.querySelectorAll('[data-kit-approval-card]')).toHaveLength(0);
  });
}
