import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { commands, page, userEvent } from "vitest/browser";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot, type BrainUiRoot } from "../../src/root.js";
import { MessageBubble } from "../../src/components/chat/message-bubble.js";
import { sentTrackFiles } from "../sent-track-fixtures.js";

let renderer: Root | undefined, root: BrainUiRoot | undefined, host: HTMLDivElement | undefined, styles: HTMLStyleElement;
let viewport: { width: number; height: number }, outer: { width: number; height: number }, themeBefore: string | undefined;
beforeEach(() => { viewport = { width: innerWidth, height: innerHeight }; themeBefore = document.documentElement.dataset.theme; });
beforeAll(async () => { styles = document.createElement("style"); styles.textContent = await commands.formConsumerStyles(); document.head.append(styles); });
afterAll(() => styles.remove());
afterEach(async () => { if (renderer) flushSync(() => renderer!.unmount()); root?.dispose(); host?.remove(); renderer = undefined; root = undefined; host = undefined;
  document.documentElement.dataset.theme = themeBefore; await page.viewport(viewport.width, viewport.height);
  if (outer) await commands.formViewport(outer.width - 100, outer.height - 120);
});
const noop = () => {};
const timestamp = Date.parse("2026-07-12T06:12:00Z");
for (const width of [320,1280]) for (const theme of ["dark","light"]) {
  test(`${theme} ${width}: actual sent/replayed GPX and no-line KML wrap all facts and stay out of the tab order`, async () => {
    outer = await commands.formViewport(width,900); await page.viewport(width,900); document.documentElement.dataset.theme = theme;
    const requests: string[] = []; root = createBrainUiRoot({ storage:null, request:async url => { requests.push(String(url)); throw new Error("no attachment lookup"); } });
    const files = sentTrackFiles(); expect(files[0]!.bytes).toBeGreaterThan(0); expect(files[1]!.summary!.waypointCount).toBe(4);
    root.stores.chat.getState().addUserMessage(null,"Here is the route.",undefined,undefined,undefined,files);
    const message = { ...root.stores.chat.getState().draft!.messages[0]!, timestamp };
    host = document.createElement("div"); host.style.cssText=`width:${Math.min(width,720)}px;background:var(--bk-color-canvas);color:var(--bk-color-ink)`; document.body.append(host); renderer=createRoot(host);
    const draw = (value: typeof message) => flushSync(() => renderer!.render(<BrainUiProvider root={root!}><button data-before>Before attachments</button><MessageBubble message={value}
      onToolApproval={noop} onAskUserSubmit={noop} onAskUserCancel={noop} onAskUserListSubmit={noop}/><button data-after>Continue</button></BrainUiProvider>));
    draw(message); const rows = [...host.querySelectorAll<HTMLElement>('[data-kit-attachment-row]')]; expect(rows).toHaveLength(2);
    const facts = rows.map(row => row.textContent); expect(facts[0]).toContain(files[0]!.incomingName); expect(facts[0]).toContain(`Staged as ${files[0]!.name}`);
    expect(facts[1]).toContain("4 waypoints; no usable track line. The original is attached.");
    for (const row of rows) {
      expect(row.getAttribute('role')).toBeNull(); expect(row.hasAttribute('tabindex')).toBe(false);
      expect(row.querySelectorAll('a,button,[role="button"],[tabindex]')).toHaveLength(0);
      for (const line of row.querySelectorAll<HTMLElement>('b,span')) {
        expect(line.scrollWidth,"complete supplied label/metadata fits").toBeLessThanOrEqual(line.clientWidth+1);
        if (line.tagName === "B") { expect(getComputedStyle(line).textOverflow).not.toBe("ellipsis"); expect(getComputedStyle(line).whiteSpace).toBe("normal"); }
      }
    }
    expect(host.textContent).not.toContain("0:38"); expect(host.textContent).not.toContain("transcribed on device"); expect(host.textContent).not.toContain("untrusted"); expect(requests).toEqual([]);
    host.querySelector<HTMLButtonElement>('[data-before]')!.focus(); await userEvent.tab(); expect(document.activeElement).toBe(host.querySelector('[data-after]'));
    root.stores.chat.getState().setActiveSession("sent-replay");
    root.connection.handleServerMessage({ type:"session_history",sessionId:"sent-replay",messages:[{role:"user",content:message.content,toolCalls:[],files}] });
    draw({ ...root.stores.chat.getState().buffers['sent-replay']!.messages[0]!,timestamp });
    expect([...host.querySelectorAll('[data-kit-attachment-row]')].map(row=>row.textContent)).toEqual(facts);
    expect(requests).toEqual([]);
    await expect.poll(()=>getComputedStyle(host!.querySelector('[data-kit-attachment-row]')!.closest('.py-4')!).opacity).toBe("1");
    await commands.formViewport(width,Math.ceil(host.scrollHeight)+32); await page.viewport(width,Math.ceil(host.scrollHeight)+32);
    await page.screenshot({element:host,path:`../../.vitest-attachments/sent-attachments/${theme}-${width}.png`});
  });
  test(`${theme} ${width}: live images retain 80px zoom targets and replay retains only its known count`, async () => {
    outer=await commands.formViewport(width,800); await page.viewport(width,800); document.documentElement.dataset.theme=theme;
    root=createBrainUiRoot({storage:null});
    const pixel = document.createElement('canvas'); pixel.width = 1; pixel.height = 1; pixel.getContext('2d')!.fillRect(0,0,1,1);
    const preview = pixel.toDataURL('image/png');
    root.stores.chat.getState().addUserMessage(null,"The crossing.",undefined,[{previewUrl:preview,mediaType:"image/png"}],undefined);
    host=document.createElement('div');host.style.width=`${Math.min(width,720)}px`;document.body.append(host);renderer=createRoot(host);
    const draw=()=>flushSync(()=>renderer!.render(<BrainUiProvider root={root!}><MessageBubble message={{...root!.stores.chat.getState().draft!.messages[0]!,timestamp}} onToolApproval={noop} onAskUserSubmit={noop} onAskUserCancel={noop} onAskUserListSubmit={noop}/></BrainUiProvider>));
    draw();const image=host.querySelector('img')!;await expect.poll(()=>image.naturalWidth).toBe(1);expect(image.getBoundingClientRect().width).toBe(80);expect(image.getBoundingClientRect().height).toBe(80);
    expect(host.querySelectorAll('[data-kit-attachment-row]')).toHaveLength(0);image.focus();await userEvent.keyboard('{Enter}');
    await expect.poll(()=>document.querySelectorAll('[role="dialog"]').length).toBe(1);
    await userEvent.keyboard('{Escape}');await expect.poll(()=>document.querySelectorAll('[role="dialog"]').length).toBe(0);
    root.connection.handleServerMessage({type:'session_history',messages:[{role:'user',content:'The crossing.',toolCalls:[],attachmentCount:1}]});draw();
    expect(host.textContent).toContain('1 image');expect(host.querySelectorAll('img,[data-kit-attachment-row]')).toHaveLength(0);
  });
}

/**
 * Sent composer originals (#3155): each row says what the host recorded the
 * agent reading (#3589), from the session's reads route and its live frames.
 * The real root, its reads client and MessageBubble; the host is a fixture
 * answering the route. No key, no network.
 */
const ORIGINALS = (() => {
  const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const base = (n: number, name: string) => ({ fileId: id(n), name, path: `.brain-ui/attachments/${id(n)}/${name}`, sha256: String(n).repeat(64) });
  return [
    { ...base(1, "ithaca-permit-harbour-fees-and-mooring-rules.pdf"), mediaType: "application/pdf", bytes: 2_516_582, kind: "pdf", reader: "pdf" },
    { ...base(2, "crew-list.txt"), mediaType: "text/plain", bytes: 1_843, kind: "text", reader: "text" },
    { ...base(3, "sirens.m4a"), mediaType: "audio/mp4", bytes: 3_250_000, kind: "binary", reader: "none" },
    { ...base(4, "aeolus-ledger.pdf"), mediaType: "application/pdf", bytes: 655_360, kind: "pdf", reader: "pdf" },
  ] as const;
})();
for (const width of [320,1280]) for (const theme of ["dark","light"]) {
  test(`${theme} ${width}: sent originals show recorded reads, update in place from a frame, and claim nothing before the host answers`, async () => {
    outer = await commands.formViewport(width,900); await page.viewport(width,900); document.documentElement.dataset.theme = theme;
    const SESSION = "odysseus-ithaca";
    const asked: string[] = [];
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    const at = Date.parse("2026-07-12T06:14:00Z");
    root = createBrainUiRoot({ storage:null, request: async url => {
      asked.push(new URL(String(url), "http://fixture.invalid").pathname);
      if (!String(url).includes("/attachment-reads")) throw new Error("only the reads route is fixtured");
      await answered;
      return Response.json({ sessionId: SESSION, reads: [
        { fileId: ORIGINALS[0].fileId, turnId: "turn-1", outcome: "read", scope: { pages: [1, 3], pageCount: 12 }, at },
        { fileId: ORIGINALS[3].fileId, turnId: "turn-1", outcome: "encrypted", scope: null, at: at + 1 },
      ] });
    } });
    root.stores.chat.getState().setActiveSession(SESSION);
    root.connection.handleServerMessage({ type: "server_hello", protocolRev: 5, capabilities: { composerFiles: true, attachmentReads: true } });
    root.connection.handleServerMessage({ type:"session_history",sessionId:SESSION,messages:[{role:"user",content:"Which harbour fees does the permit list?",toolCalls:[],attachmentFiles:[...ORIGINALS]}] });
    host = document.createElement("div"); host.style.cssText=`width:${Math.min(width,720)}px;background:var(--bk-color-canvas);color:var(--bk-color-ink)`; document.body.append(host); renderer=createRoot(host);
    flushSync(() => renderer!.render(<BrainUiProvider root={root!}><MessageBubble message={{ ...root!.stores.chat.getState().buffers[SESSION]!.messages[0]!, timestamp }}
      onToolApproval={noop} onAskUserSubmit={noop} onAskUserCancel={noop} onAskUserListSubmit={noop}/></BrainUiProvider>));
    const rows = () => [...host!.querySelectorAll<HTMLElement>("[data-sent-files] [data-kit-attachment-row]")].map((row) => row.textContent ?? "");
    expect(asked).toEqual([`/api/sessions/${SESSION}/attachment-reads`]);
    // Before the host answers, no row claims read or not read yet.
    expect(rows()).toHaveLength(4);
    for (const row of rows()) expect(row).not.toMatch(/not read yet|\bread\b|couldn't read/);
    answer();
    await expect.poll(() => rows()[0]).toContain("PDF · 2.4 MB · read p. 1–3");
    expect(rows()[1]).toContain("Text · 1.8 KB · not read yet");
    expect(rows()[2]).toContain("3.1 MB · no reader for this kind of file");
    expect(rows()[3]).toContain("PDF · 640.0 KB · couldn't read: password-protected");
    // A later turn's read arrives as a frame and updates its row in place.
    root.connection.handleServerMessage({ type: "attachment_read", sessionId: SESSION, read: { fileId: ORIGINALS[1].fileId, turnId: "turn-2", outcome: "partial", scope: { bytes: [0, 1_024], totalBytes: 1_843 }, at: at + 2 } });
    await expect.poll(() => rows()[1]).toContain("Text · 1.8 KB · read stopped at 1.0 KB");
    for (const row of host.querySelectorAll<HTMLElement>("[data-sent-files] [data-kit-attachment-row]")) {
      for (const line of row.querySelectorAll<HTMLElement>("b,span")) expect(line.scrollWidth, "complete label/metadata fits").toBeLessThanOrEqual(line.clientWidth + 1);
    }
    expect(asked, "one read of the route, no other request").toHaveLength(1);
    await expect.poll(()=>getComputedStyle(host!.querySelector('[data-kit-attachment-row]')!.closest('.py-4')!).opacity).toBe("1");
    await commands.formViewport(width,Math.ceil(host.scrollHeight)+32); await page.viewport(width,Math.ceil(host.scrollHeight)+32);
    await page.screenshot({element:host,path:`../../.vitest-attachments/sent-attachments/originals-${theme}-${width}.png`});
  });
}
