// Render smoke tests for approval cards and decisions, run lanes, the orbit and permission mirrors: mount the components in happy-dom and
// assert the DOM they produce. Fixtures are minimal and keyless; nothing here
// touches the network. Shared setup: ./smoke-harness.tsx.
//
// The DOM module import MUST stay first: it registers the happy-dom globals
// before the component module bodies run (./dom.ts explains why, and why
// `screen` must not be used).
import { registerSmokeApprovalsDom, unregisterSmokeApprovalsDom } from "./smoke-approvals-dom.js";
registerSmokeApprovalsDom();

import { installSmokeHarness, PageSocket, activityDetail, flushPromises, installActivityFetch, render, useChatStore } from "./smoke-harness.js";
import { describe, expect, test } from "bun:test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import type { ActivityRunDetail } from "@schlessera/brain-ui-sdk/protocol";
import { RunDetail } from "../../src/components/activity/activity-run-detail.js";
import { SpanEventBlock } from "../../src/components/activity/span-bits.js";
import { ActivityPage } from "../../src/components/activity/activity-page.js";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { ChatPage } from "../../src/components/chat/chat-page.js";
import type { ToolCall } from "../../src/stores/chat-store.js";
import { ApprovalCard, approvalOutcome } from "../../src/components/activity/approval-card.js";
import { BrainUiProvider } from "../../src/root-context.js";
import { createBrainUiRoot } from "../../src/root.js";
import { activeChat } from "../../src/stores/chat-store.js";
import { timedSpans as recordedTimedSpans } from "../lane-fixtures.js";
import { recordedLanes as actualRecordedLanes } from "../../src/components/activity/run-lanes.js";
import { laneStart as recordedLaneStart } from "../lane-fixtures.js";
import { parallelSpans as realParallelSpans } from "../orbit-fixtures.js";
import { orbitAgent as mapRecordedOrbitAgent } from "../../src/components/activity/run-orbit.js";
import { SubagentView as PermissionSubagentView } from "../../src/components/chat/subagent-view.js";
import { replyToToolApproval } from "../../src/lib/tool-approval.js";
import type { ClientMessage as PermissionReply } from "@schlessera/brain-ui-sdk/protocol";

installSmokeHarness(unregisterSmokeApprovalsDom);

/* ── #147: a card never offers a grant the host will not keep ───────────── */

describe("approval cards follow rememberability (#147)", () => {
  function card(extra: Partial<ToolCall>): ToolCall {
    return {
      id: "t1",
      name: "mcp_proxy_tool",
      input: {},
      inputJson: "{}",
      status: "pending_approval",
      ...extra,
    } as ToolCall;
  }
  // The three states a card can be in. Only the first may offer the button.
  const OFFERED = card({ approvalKind: "tool" });
  const UNKEPT = card({ approvalKind: "tool", approvalRememberable: false });
  const COMMAND = card({ name: "Bash", approvalKind: "command" });

  test("the transcript card drops Always allow when the host will not keep it", () => {
    for (const [tool, offered] of [[OFFERED, true], [UNKEPT, false], [COMMAND, false]] as const) {
      const view = render(<ToolCallTimeline toolCalls={[tool]} onApproval={() => {}} />);
      expect(view.queryByRole("button", { name: /^Always allow/ }) !== null).toBe(offered);
      // Allow and Deny are never what this changes.
      expect(view.getByRole("button", { name: /^Allow/ })).toBeTruthy();
      expect(view.getByRole("button", { name: /^Deny/ })).toBeTruthy();
      view.unmount();
    }
  });

  test("the Actions card drops Always allow when the host will not keep it", () => {
    for (const [tool, offered] of [[OFFERED, true], [UNKEPT, false], [COMMAND, false]] as const) {
      const view = render(<ApprovalCard tool={tool} origin="this conversation" keys onDecide={() => {}} />);
      expect(view.queryByRole("button", { name: /Always allow/ }) !== null).toBe(offered);
      expect(view.getByRole("button", { name: /^Allow/ })).toBeTruthy();
      view.unmount();
    }
  });

  test("an always the card could not offer is neither printed nor sent", () => {
    // The button is gone, so this is the guard behind it: whatever reaches
    // the decision, the receipt and the frame follow the card.
    for (const tool of [UNKEPT, COMMAND, undefined]) {
      const { receipt, frame } = approvalOutcome(tool, "t1", true, true);
      expect(receipt.text).toBe("Allowed");
      expect(receipt.effect).toBe("tool_approval");
      expect(frame).toEqual({ type: "tool_approval", toolUseId: "t1", channel: "card" });
    }
    const kept = approvalOutcome(OFFERED, "t1", true, true);
    expect(kept.receipt).toEqual({ text: "Always allowed", target: "mcp_proxy_tool", effect: "write_policy" });
    expect(kept.frame).toEqual({ type: "tool_approval", toolUseId: "t1", always: true, channel: "card" });
    expect(approvalOutcome(OFFERED, "t1", false, true).frame).toEqual({
      type: "tool_denial",
      toolUseId: "t1",
      message: "Denied by user",
      channel: "card",
    });
  });

  /**
   * Driven from the wire: the frame the host sends, through the socket
   * handler and the store, to the Actions page and the receipt it prints.
   */
  async function actionsFrom(frame: Record<string, unknown>, before: Record<string, unknown>[] = []) {
    installActivityFetch();
    globalThis.WebSocket = PageSocket as unknown as typeof WebSocket;
    const root = createBrainUiRoot({ storage: null });
    const release = root.connection.connect();
    let page: ReturnType<typeof render> | undefined;
    const done = () => {
      page?.unmount();
      release();
      root.dispose();
    };
    try {
      const socket = PageSocket.instances.at(-1)!;
      // Delivering it again is the re-delivery a reconnect produces.
      const card = () =>
        act(() =>
          socket.deliver({
            type: "tool_approval_request",
            toolUseId: "t1",
            toolName: "mcp_proxy_tool",
            input: {},
            kind: "tool",
            ...frame,
          })
        );
      act(() => {
        socket.open();
        socket.deliver({ type: "text_delta", text: "working" });
        root.connection.flushChatDeltas();
        for (const f of before) socket.deliver(f);
      });
      card();
      page = render(<BrainUiProvider root={root}><ActivityPage /></BrainUiProvider>);
      await act(flushPromises);
      const approvals = () =>
        socket.sent
          .map((f) => JSON.parse(f) as Record<string, unknown>)
          .filter((f) => f.type === "tool_approval" || f.type === "tool_denial");
      const tools = () => activeChat(root.stores.chat.getState()).messages.flatMap((m) => m.toolCalls);
      return { page, approvals, done, card, tools };
    } catch (error) {
      done();
      throw error;
    }
  }

  test("an unkept card's receipt never says Always allowed, and no always goes on the wire", async () => {
    const { page, approvals, done } = await actionsFrom({ rememberable: false });
    try {
      // Whatever the card offers is what the user can press. Before #147 it
      // offered Always allow here and the receipt printed a policy write the
      // host then refused; now it offers Allow, and the receipt says that.
      const always = page.queryByRole("button", { name: /Always allow/ });
      fireEvent.click(always ?? page.getByRole("button", { name: /^Allow/ }));
      await act(flushPromises);
      expect(page.container.textContent).not.toContain("Always allowed");
      expect(page.getByText("Allowed")).toBeTruthy();
      expect(approvals()).toEqual([{ type: "tool_approval", toolUseId: "t1", channel: "card" }]);
      expect(always === null).toBe(true);
    } finally {
      done();
    }
  });

  test("the marking survives replacing a streamed tool and a re-delivered card", async () => {
    // The approval usually lands on a tool that already streamed, and a
    // reconnect delivers the card again; both replace the stored ToolCall.
    const streamed = [
      { type: "tool_use_start", toolUseId: "t1", toolName: "mcp_proxy_tool" },
      { type: "tool_use_complete", toolUseId: "t1", toolName: "mcp_proxy_tool", input: {} },
    ];
    const { page, done, card, tools } = await actionsFrom({ rememberable: false }, streamed);
    try {
      // One stored tool each time: the card replaced the streamed call rather
      // than appending a second one beside it (which the pending-only Actions
      // list would hide), and the re-delivery replaced it again.
      for (const round of [1, 2]) {
        if (round === 2) card();
        expect(tools().map((t) => [t.id, t.status, t.approvalRememberable])).toEqual([
          ["t1", "pending_approval", false],
        ]);
        expect(page.getAllByRole("button", { name: /^Allow/ })).toHaveLength(1);
        expect(page.queryByRole("button", { name: /Always allow/ }) === null).toBe(true);
      }
    } finally {
      done();
    }
  });

  test("a card the host will keep still offers Always allow and still says so", async () => {
    const { page, approvals, done } = await actionsFrom({});
    try {
      fireEvent.click(page.getByRole("button", { name: /Always allow/ }));
      await act(flushPromises);
      expect(page.getByText("Always allowed")).toBeTruthy();
      expect(approvals()).toEqual([{ type: "tool_approval", toolUseId: "t1", always: true, channel: "card" }]);
    } finally {
      done();
    }
  });
});

/* ── #113: a resolved approval names the channel it was made on ─────────── */

describe("approval decisions in the run detail (#113)", () => {
  test("a decision on the transcript's card is sent as made on the card", async () => {
    globalThis.fetch = (async () =>
      Response.json({ entries: [], providers: [], backends: {}, slugs: {}, models: [], sessions: [] })) as unknown as typeof fetch;
    globalThis.WebSocket = PageSocket as unknown as typeof WebSocket;
    const root = createBrainUiRoot({ storage: null });
    const release = root.connection.connect();
    let view: ReturnType<typeof render> | undefined;
    try {
      const socket = PageSocket.instances.at(-1)!;
      act(() => {
        socket.open();
        socket.deliver({ type: "text_delta", text: "working" });
        root.connection.flushChatDeltas();
        for (const toolUseId of ["t1", "t2"]) {
          socket.deliver({ type: "tool_approval_request", toolUseId, toolName: "Write", input: {}, kind: "tool" });
        }
      });
      view = render(<BrainUiProvider root={root}><ChatPage /></BrainUiProvider>);
      await act(flushPromises);
      fireEvent.click(view.getAllByRole("button", { name: /^Allow/ })[0]!);
      fireEvent.click(view.getByRole("button", { name: /^Deny/ }));
      const sent = socket.sent
        .map((f) => JSON.parse(f) as Record<string, unknown>)
        .filter((f) => f.type === "tool_approval" || f.type === "tool_denial");
      expect(sent).toEqual([
        { type: "tool_approval", toolUseId: "t1", channel: "card" },
        { type: "tool_denial", toolUseId: "t2", message: "Denied by user", channel: "card" },
      ]);
    } finally {
      view?.unmount();
      release();
      root.dispose();
    }
  });

  test("a decision it cannot read falls back to the raw record, never a sentence", () => {
    for (const payload of [{ decision: "__proto__" }, { decision: "allow", channel: "toString" }, { decision: "allow", channel: "telepathy" }]) {
      const view = render(<SpanEventBlock event={{ spanId: "t1", eventIndex: 0, ts: 1, eventType: "approval_decision", payload }} />);
      expect(view.queryByTestId("approval-decision") === null).toBe(true);
      expect(view.container.textContent).toContain("approval decision");
      expect(view.container.textContent).toContain(JSON.stringify(payload, null, 2));
      view.unmount();
    }
  });

  test("each recorded decision reads as what was decided and how", async () => {
    const decisions = [
      { principalId: "p-1", decision: "deny", requestKind: "tool", channel: "voice" },
      { principalId: "p-1", decision: "always_allow", requestKind: "tool", channel: "card" },
      // Recorded before the channel existed, or by a client that did not say.
      { principalId: "p-1", decision: "allow", requestKind: "command" },
    ];
    const detail: ActivityRunDetail = {
      ...activityDetail("run-113", "Approvals"),
      spans: [
        { spanId: "run-113:turn", runId: "run-113", name: "turn", kind: "turn", origin: "session", startedAt: 1, endedAt: 9, outcome: "success" },
        { spanId: "t1", runId: "run-113", parentSpanId: "run-113:turn", name: "execute_tool Write", toolName: "Write", kind: "tool", origin: "session", startedAt: 2, endedAt: 8, outcome: "success" },
      ],
      events: decisions.map((payload, eventIndex) => ({ spanId: "t1", eventIndex, ts: 3 + eventIndex, eventType: "approval_decision", payload })),
    };
    const root = createBrainUiRoot({ storage: null, request: async () => Response.json(detail) });
    const view = render(<BrainUiProvider root={root}><RunDetail runId="run-113" onBack={() => {}} /></BrainUiProvider>);
    try {
      await act(flushPromises);
      fireEvent.click(view.getByText("Write"));
      expect(view.container.textContent).toContain("Denied by voice");
      const rows = view.getAllByTestId("approval-decision").map((row) => row.textContent);
      expect(rows).toEqual(["Denied by voice", "Always allowed on the card", "Allowed"]);
    } finally {
      view.unmount();
      root.dispose();
    }
  });
});

test("recorded lanes use one independently computed axis and known wait boundaries",()=>{
  const chart=actualRecordedLanes(recordedTimedSpans(),recordedLaneStart+90000,false);
  expect(chart.lanes).toHaveLength(4);expect(chart.start).toBe(recordedLaneStart);expect(chart.duration).toBe(60000);
  expect(chart.ticks).toEqual(['0.0s','20.0s','40.0s','1m 0s']);
  expect(chart.lanes[1]!.segments).toEqual([{start:25,width:50}]);
  expect(chart.lanes[0]!.segments[0]!.hatch).toBe(true);expect(chart.lanes[0]!.segments[0]!.width).toBeCloseTo(100/6,8);
  expect(chart.lanes[0]!.segments[1]!.start).toBeCloseTo(100/6,8);expect(chart.lanes[0]!.segments[1]!.width).toBe(50);
});

test("invalid and absent terminal timing never become a live tail or invented approval interval",()=>{
  const spans=recordedTimedSpans();
  spans[1]={...spans[1]!,waitUntil:recordedLaneStart+50000};spans[2]={...spans[2]!,endedAt:undefined};spans[3]={...spans[3]!,startedAt:Number.NaN};
  const chart=actualRecordedLanes(spans,recordedLaneStart+90000,true);
  expect(chart.rows).toHaveLength(4);expect(chart.lanes).toHaveLength(2);
  expect(chart.lanes.flatMap(l=>l.segments).filter(s=>s.hatch||s.fade)).toHaveLength(0);
  expect(chart.rows[0]!.missing).toBe('Approval boundary unavailable');expect(chart.rows[1]!.missing).toBe('End not recorded');expect(chart.rows[2]!.missing).toBe('Start not recorded');
});

test("only recorded-active spans get an advancing open tail, then a real terminal end wins",()=>{
  const spans=recordedTimedSpans();spans[0]={...spans[0]!,endedAt:undefined,outcome:undefined};spans[1]={...spans[1]!,endedAt:undefined,outcome:undefined};
  const first=actualRecordedLanes(spans,recordedLaneStart+60000,true);const later=actualRecordedLanes(spans,recordedLaneStart+90000,true);
  expect(first.rows[0]!.active).toBe(true);expect(first.lanes[0]!.segments.at(-1)!.fade).toBe(true);expect(later.duration).toBe(90000);
  expect(later.rows[0]!.end).toBe(recordedLaneStart+90000);
  expect(actualRecordedLanes(spans,recordedLaneStart+90000,false).rows[0]!.missing).toBe('End not recorded');
  spans[1]={...spans[1]!,endedAt:recordedLaneStart+70000,outcome:'denied'};
  const terminal=actualRecordedLanes(spans,recordedLaneStart+90000,true);expect(terminal.rows[0]!.active).toBe(false);expect(terminal.rows[0]!.end).toBe(recordedLaneStart+70000);expect(terminal.lanes[0]!.segments.at(-1)!.fade).toBeUndefined();expect(terminal.rows[0]!.span.outcome).toBe('denied');
});

for(const variant of ['empty','pruned','unsupported'] as const)test(`run lanes stay absent for ${variant} data`,async()=>{
  const spans=variant==='empty'?[]:recordedTimedSpans();const root=createBrainUiRoot({storage:null,request:async()=>Response.json({runId:'crossing-lanes',detailPruned:variant==='pruned',spans,events:[],highWaterSeq:0})});
  root.stores.activity.setState({supported:variant!=='unsupported'});
  try{const view=render(<BrainUiProvider root={root}><RunDetail runId='crossing-lanes' onBack={()=>{}}/></BrainUiProvider>);
    if(variant==='pruned')await waitFor(()=>expect(view.container.textContent).toContain('Trace pruned'));
    else await act(async()=>{await Promise.resolve();});
    expect(view.container.querySelector('[data-kit-lane-chart]')).toBeNull();expect(view.container.textContent).not.toContain('waiting on you');
  }finally{await act(async()=>root.dispose());}
});

for (const backend of ["claude", "pi"] as const) {
  test(`${backend} actual run detail mounts truthful subagent orbit and the existing drill-in`, async () => {
    const spans = realParallelSpans();
    const root = createBrainUiRoot({ storage: null, request: async () => Response.json({ runId: "crossing-run", detailPruned: false, spans, events: [], highWaterSeq: 0 }) });
    try {
      root.stores.activity.setState({ supported: true });
      root.stores.chat.getState().setActiveSession("crossing-chat");
      root.stores.chat.getState().startAssistantMessage("crossing-chat");
      root.stores.chat.getState().requestToolApproval("crossing-chat", "approval-write", "Write", { file_path: "voyage/crossing.md" });
      root.stores.chat.setState({ backendIds: { "crossing-chat": backend } });
      expect(root.stores.chat.getState().buffers["crossing-chat"]!.messages.at(-1)!.toolCalls[0]!.status).toBe("pending_approval");
      root.stores.chat.getState().setActiveSession("other-chat");
      const view = render(<BrainUiProvider root={root}><RunDetail runId="crossing-run" onBack={() => {}} /></BrainUiProvider>);
      await waitFor(() => expect(root.stores.activity.getState().spanRun["watch"]).toBe("crossing-run"));
      expect(spans.filter(s => s.kind === "subagent")).toHaveLength(6);
      expect(view.container.querySelectorAll('[data-kit-agent-orbit]')).toHaveLength(1);
      expect(view.getByRole("group", { name: "Agents: 1 needs you, 2 running, 3 ended" })).toBeTruthy();
      const cancelled = view.container.querySelector('[data-orbit-agent="watch"]')!;
      expect(cancelled.getAttribute("data-orbit-state")).toBe("stopped");
      expect(cancelled.getAttribute("data-orbit-ring")).toBe("2");
      fireEvent.click(view.getByRole("button", { name: "Open researcher · needs approval" }));
      expect(root.stores.ui.getState().activeView).toBe("chat");
      expect(root.stores.chat.getState().activeSessionId).toBe("crossing-chat");
      expect(root.stores.ui.getState().subagentStack).toEqual(["research"]);
    } finally { await act(async()=>root.dispose()); }
  });
}

test("all terminal outcomes keep their meaning and beat an older pending approval", () => {
  const span = realParallelSpans().find(s => s.spanId === "research")!;
  expect(span.subagent?.type).toBe("researcher");
  for (const [outcome,state] of [["success","done"],["error","failed"],["timeout","failed"],["interrupted","failed"],["denied","stopped"],["cancelled","stopped"]] as const) {
    const actual = mapRecordedOrbitAgent({...span,outcome,endedAt:span.startedAt+8000},true);
    expect(actual.state).toBe(state);expect(actual.meta).toBe(`${outcome} · 8.0s`);
  }
  const unknown = mapRecordedOrbitAgent({...span,subagent:undefined},false);
  expect(unknown.name).toBe("agent");expect(unknown.meta).toBeUndefined();
});

for (const variant of ["unsupported","pruned","single","empty"] as const) {
  test(`run orbit is absent for ${variant} data, including cached spans`, async () => {
    const full = realParallelSpans();
    const spans = variant === "single" ? full.filter(s=>s.spanId==="root"||s.spanId==="coast") : variant === "empty" ? [] : full;
    const root = createBrainUiRoot({storage:null,request:async()=>Response.json({runId:"crossing-run",detailPruned:variant==="pruned",spans,events:[],highWaterSeq:0})});
    root.stores.activity.setState({supported:variant!=="unsupported"});
    root.stores.activity.getState().applySnapshot({type:"activity_snapshot",view:"run",runId:"crossing-run",spans,events:[],highWaterSeq:{"crossing-run":0}});
    try {
      const view=render(<BrainUiProvider root={root}><RunDetail runId="crossing-run" onBack={()=>{}}/></BrainUiProvider>);
      if(variant==="pruned")await waitFor(()=>expect(view.container.textContent).toContain("Trace pruned"));
      expect(view.container.querySelectorAll('[data-kit-agent-orbit]')).toHaveLength(0);
      expect(view.container.textContent).not.toContain("4,812");
    }finally{await act(async()=>root.dispose());}
  });
}

test("live approval and terminal frames update the same orbit without an announcement region", async () => {
  const spans=realParallelSpans();const root=createBrainUiRoot({storage:null,request:async()=>Response.json({runId:"crossing-run",detailPruned:false,spans,events:[],highWaterSeq:0})});
  root.stores.activity.setState({supported:true});root.stores.chat.getState().setActiveSession("crossing-chat");root.stores.chat.getState().startAssistantMessage("crossing-chat");
  try {
    const view=render(<BrainUiProvider root={root}><RunDetail runId="crossing-run" onBack={()=>{}}/></BrainUiProvider>);
    await waitFor(()=>expect(view.container.querySelector('[data-kit-agent-orbit]')).toBeTruthy());
    const orbit=view.container.querySelector('[data-kit-agent-orbit]')!;
    expect(orbit.getAttribute('aria-label')).toBe("Agents: 0 needs you, 3 running, 3 ended");
    act(()=>root.stores.chat.getState().requestToolApproval("crossing-chat","approval-write","Write",{file_path:"voyage/crossing.md"}));
    expect(orbit.getAttribute('aria-label')).toBe("Agents: 1 needs you, 2 running, 3 ended");
    act(()=>root.connection.handleServerMessage({type:"activity_delta",runId:"crossing-run",seq:1,span:{...spans.find(s=>s.spanId==="research")!,outcome:"denied"}}));
    expect(orbit.getAttribute('aria-label')).toBe("Agents: 0 needs you, 2 running, 4 ended");
    expect(orbit.querySelector('[data-orbit-agent="research"]')?.getAttribute('data-orbit-state')).toBe("stopped");
    expect(orbit.querySelectorAll('[aria-live],[role="status"]')).toHaveLength(0);
  }finally{await act(async()=>root.dispose());}
});

const permissionTool: ToolCall = { id:"permission-original",name:"Edit",input:{file_path:"knowledge/scylla.md",old_string:"Risk six men.",new_string:"Keep the crossing visible."},inputJson:"{}",status:"pending_approval",approvalKind:"tool" };

for(const location of ["main","subagent"] as const){
  test(`${location} actual pending permission uses the kit ApprovalCard and original nonempty diff`,()=>{
    const root=createBrainUiRoot({storage:null});const decisions:unknown[]=[];
    root.stores.chat.getState().requestToolApproval(null,permissionTool.id,permissionTool.name,permissionTool.input,undefined,"tool");
    const span={spanId:"permission-agent",runId:"permission-run",sessionId:"permission-session",origin:"session" as const,kind:"subagent" as const,name:"Agent",startedAt:0};
    const child={...span,spanId:permissionTool.id,parentSpanId:span.spanId,kind:"tool" as const,name:"Edit"};
    root.stores.activity.setState({spans:{"permission-run":{[span.spanId]:span,[child.spanId]:child}},spanRun:{[span.spanId]:span.runId,[child.spanId]:child.runId}});
    try {
      const onApproval=(...args:unknown[])=>decisions.push(args);
      const view=render(<BrainUiProvider root={root}>{location==="main"?<ToolCallTimeline toolCalls={[permissionTool]} onApproval={onApproval}/>:<PermissionSubagentView spanId={span.spanId} onApproval={onApproval}/>}</BrainUiProvider>);
      expect(activeChat(root.stores.chat.getState()).messages.at(-1)!.toolCalls).toHaveLength(1);
      expect(view.container.textContent).toContain("Edit");
      expect(permissionTool.input.old_string).not.toBe("");expect(permissionTool.input.new_string).not.toBe("");
      expect(view.container.querySelectorAll('[data-kit-approval-card]')).toHaveLength(1);
      const card=view.container.querySelector('[data-kit-approval-card]')!;
      expect(card.textContent).toContain("knowledge/scylla.md");expect(card.textContent).toContain("Risk six men.");expect(card.textContent).toContain("Keep the crossing visible.");
      fireEvent.click(view.getByRole("button",{name:/^Allow(?:$| )/}));expect(decisions).toEqual([[permissionTool.id,true,undefined]]);
    }finally{root.dispose();}
  });
}

function permissionMirror(root: ReturnType<typeof createBrainUiRoot>) {
  const span={spanId:"permission-agent",runId:"permission-run",kind:"subagent" as const,origin:"session" as const,name:"Agent",startedAt:0};
  const child={...span,spanId:permissionTool.id,parentSpanId:span.spanId,kind:"tool" as const,name:"Edit"};
  root.stores.activity.setState({spans:{[span.runId]:{[span.spanId]:span,[child.spanId]:child}},spanRun:{[span.spanId]:span.runId,[child.spanId]:child.runId}});
  return span;
}

for (const location of ["main", "subagent"] as const) {
  test(`${location} refused tool permission keeps its original control for a later explicit decision`, () => {
    const root = createBrainUiRoot({ storage: null });
    const accepted: PermissionReply[] = [];
    let connected = false;
    root.stores.chat.getState().requestToolApproval(null, permissionTool.id, permissionTool.name, permissionTool.input, undefined, "tool");
    const span = permissionMirror(root);
    const decide = (id: string, approved: boolean, always?: boolean) => replyToToolApproval(root, null, message => {
      if (!connected) return false;
      accepted.push(message);
      return true;
    }, id, approved, always);
    function Pending() {
      const calls = useChatStore(s => activeChat(s).messages.at(-1)?.toolCalls ?? []);
      return <>{location === "main" ? <ToolCallTimeline live toolCalls={calls} onApproval={decide} /> : <PermissionSubagentView spanId={span.spanId} onApproval={decide} />}<textarea data-composer aria-label="continue after permission" /></>;
    }
    try {
      const view = render(<BrainUiProvider root={root}><Pending /></BrainUiProvider>);
      const allow = view.getByRole("button", { name: /^Allow(?:$| )/ });
      allow.focus();
      fireEvent.click(allow);
      expect(activeChat(root.stores.chat.getState()).messages.at(-1)!.toolCalls[0]!.status, "a refused send leaves the original request pending").toBe("pending_approval");
      expect(accepted).toEqual([]);
      expect(view.getByRole("button", { name: /^Allow(?:$| )/ }), "the same explicit control remains usable").toBe(allow);
      expect(document.activeElement, "a refused decision retains focus").toBe(allow);
      connected = true;
      fireEvent.click(allow);
      expect(accepted, "one later explicit decision is accepted").toEqual([{ type: "tool_approval", toolUseId: permissionTool.id, channel: "card" }]);
      expect(activeChat(root.stores.chat.getState()).messages.at(-1)!.toolCalls[0]!.status).toBe("approved");
      expect(view.container.querySelectorAll("[data-kit-approval-card]")).toHaveLength(0);
      expect(document.activeElement).toBe(view.getByLabelText("continue after permission"));
    } finally { root.dispose(); }
  });
}

test("duplicate main and subagent controls send the original request once and share its resolved state",()=>{
  const root=createBrainUiRoot({storage:null});const replies:PermissionReply[]=[];
  root.stores.chat.getState().requestToolApproval(null,permissionTool.id,permissionTool.name,permissionTool.input,undefined,"tool");const span=permissionMirror(root);
  const send=(message:PermissionReply)=>{replies.push(message);return true;};
  const decide=(id:string,approved:boolean,always?:boolean)=>replyToToolApproval(root,null,send,id,approved,always);
  function Both(){const calls=useChatStore(s=>activeChat(s).messages.at(-1)?.toolCalls??[]);return <><ToolCallTimeline live toolCalls={calls} onApproval={decide}/><PermissionSubagentView spanId={span.spanId} onApproval={decide}/><textarea data-composer aria-label="continue"/></>;}
  try {
    const view=render(<BrainUiProvider root={root}><Both/></BrainUiProvider>);
    expect(view.container.querySelectorAll('[data-kit-approval-card]')).toHaveLength(2);
    const allow=view.getAllByRole("button",{name:/^Allow(?:$| )/});const deny=view.getAllByRole("button",{name:/^Deny/});expect(allow).toHaveLength(2);
    act(()=>{fireEvent.click(allow[0]!);fireEvent.click(deny[1]!);});
    expect(replies).toEqual([{type:"tool_approval",toolUseId:permissionTool.id,channel:"card"}]);
    expect(activeChat(root.stores.chat.getState()).messages.at(-1)!.toolCalls[0]!.status).toBe("approved");
    expect(view.container.querySelectorAll('[data-kit-approval-card]')).toHaveLength(0);
    expect(document.activeElement).toBe(view.getByLabelText("continue"));
  }finally{root.dispose();}
});

for(const [choice,approved,always] of [["Allow",true,undefined],["Deny",false,undefined],["Always allow",true,true]] as const){
  test(`${choice} on the subagent retains its exact request and eligibility`,()=>{
    const root=createBrainUiRoot({storage:null});const replies:PermissionReply[]=[];
    root.stores.chat.getState().requestToolApproval(null,permissionTool.id,permissionTool.name,permissionTool.input,undefined,"tool");const span=permissionMirror(root);
    try {const view=render(<BrainUiProvider root={root}><PermissionSubagentView spanId={span.spanId} onApproval={(id,ok,keep)=>replyToToolApproval(root,null,message=>{replies.push(message);return true;},id,ok,keep)}/></BrainUiProvider>);
      fireEvent.click(view.getByRole("button",{name:choice==="Always allow"?/^Always allow/:choice==="Allow"?/^Allow(?:$| )/:/^Deny/}));
      expect(replies).toEqual([approved?{type:"tool_approval",toolUseId:permissionTool.id,...(always?{always:true}:{}),channel:"card"}:{type:"tool_denial",toolUseId:permissionTool.id,message:"Denied by user",channel:"card"}]);
    }finally{root.dispose();}
  });
}

for(const kind of ["command","tool"] as const){test(`${kind} unrememberable subagent has no Always allow action`,()=>{
  const root=createBrainUiRoot({storage:null});root.stores.chat.getState().requestToolApproval(null,permissionTool.id,permissionTool.name,permissionTool.input,undefined,kind,false);const span=permissionMirror(root);
  try{const view=render(<BrainUiProvider root={root}><PermissionSubagentView spanId={span.spanId} onApproval={()=>{}}/></BrainUiProvider>);expect(view.container.querySelectorAll('[data-kit-approval-card]')).toHaveLength(1);expect(view.queryByRole("button",{name:/^Always allow/}) !== null).toBe(false);}finally{root.dispose();}
});}

test("a stale Always allow callback cannot remember a command or a host-refused grant",()=>{
  for(const [kind,rememberable] of [["command",true],["tool",false]] as const){
    const root=createBrainUiRoot({storage:null});const replies:PermissionReply[]=[];
    try {root.stores.chat.getState().requestToolApproval(null,permissionTool.id,permissionTool.name,permissionTool.input,undefined,kind,rememberable);
      replyToToolApproval(root,null,message=>{replies.push(message);return true;},permissionTool.id,true,true);
      expect(replies).toEqual([{type:"tool_approval",toolUseId:permissionTool.id,channel:"card"}]);
    }finally{root.dispose();}
  }
});

test("restored closed subagent requests have no decision controls and stale callbacks send nothing",()=>{
  const root=createBrainUiRoot({storage:null});const replies:PermissionReply[]=[];
  try {
    root.stores.chat.getState().requestToolApproval(null,permissionTool.id,permissionTool.name,permissionTool.input,undefined,"tool");const span=permissionMirror(root);
    root.stores.chat.getState().closeRestoredApprovals(null,[{toolUseId:permissionTool.id,closure:"answered"}]);
    const tool=activeChat(root.stores.chat.getState()).messages.at(-1)!.toolCalls[0]!;expect(tool.restored).toBe(true);expect(tool.readOnly).toBe("answered");
    const view=render(<BrainUiProvider root={root}><PermissionSubagentView spanId={span.spanId} onApproval={(id,ok,keep)=>replyToToolApproval(root,null,message=>{replies.push(message);return true;},id,ok,keep)}/></BrainUiProvider>);
    expect(view.container.querySelectorAll('[data-kit-approval-card]')).toHaveLength(0);
    replyToToolApproval(root,null,message=>{replies.push(message);return true;},permissionTool.id,true,true);expect(replies).toEqual([]);
  }finally{root.dispose();}
});
