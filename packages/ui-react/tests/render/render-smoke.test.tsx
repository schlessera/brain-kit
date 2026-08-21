// Render smoke tests: mount the highest-traffic components in happy-dom and
// assert the DOM they produce, not just their pure helpers. Fixtures are
// minimal and keyless; nothing here touches the network.
//
// The dom.js import MUST stay first — it registers the happy-dom globals
// before the component module bodies run, and its header documents why every
// render test lives in this one file and why `screen` must not be used.
import { unregisterDom } from "./dom.js";

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { MarkdownContent } from "../../src/components/chat/markdown-content.js";
import { ToolCallTimeline } from "../../src/components/chat/tool-call-timeline.js";
import { AskUserCard } from "../../src/components/chat/ask-user-card.js";
import { ZoomViewer } from "../../src/components/viewer/zoom-viewer.js";
import type { ToolCall } from "../../src/stores/chat-store.js";
import type { AskUserQuestion } from "@schlessera/brain-ui-sdk/protocol";

afterEach(cleanup);
afterAll(unregisterDom);

describe("MarkdownContent", () => {
  test("renders heading, list, and code from markdown source", () => {
    const { getByRole, getAllByRole, baseElement } = render(
      <MarkdownContent
        content={"# Field Notes\n\n- first item\n- second item\n\n`inline code`"}
      />
    );
    expect(getByRole("heading", { level: 1 }).textContent).toBe("Field Notes");
    expect(getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "first item",
      "second item",
    ]);
    expect(baseElement.querySelector("code")?.textContent).toBe("inline code");
  });
});

describe("ToolCallTimeline", () => {
  const completedRead: ToolCall = {
    id: "tool-1",
    name: "Read",
    input: { file_path: "/data/brain/notes/example.md" },
    inputJson: JSON.stringify({ file_path: "/data/brain/notes/example.md" }, null, 2),
    status: "complete",
    output: "file contents here",
  };

  test("non-live completed run mounts as the collapsed summary row only", () => {
    const { getByRole, queryByText, baseElement } = render(
      <ToolCallTimeline toolCalls={[completedRead]} onApproval={() => {}} />
    );
    // Summary row present…
    expect(getByRole("button").textContent).toContain("1 step");
    // …and the per-entry detail subtree is NOT mounted: no tool label, no
    // input JSON, no output.
    expect(queryByText("Read")).toBeNull();
    expect(baseElement.textContent).not.toContain("file_path");
    expect(baseElement.textContent).not.toContain("file contents here");
  });

  test("expanding the summary row mounts the per-tool entries", () => {
    const { getByRole, getByText } = render(
      <ToolCallTimeline toolCalls={[completedRead]} onApproval={() => {}} />
    );
    fireEvent.click(getByRole("button"));
    expect(getByText("Read")).toBeTruthy();
  });
});

describe("AskUserCard", () => {
  const questions: AskUserQuestion[] = [
    {
      question: "Which draft should I keep?",
      header: "Draft",
      multiSelect: false,
      options: [
        { label: "Alpha", description: "the longer draft" },
        { label: "Beta", description: "the shorter draft" },
      ],
    },
  ];

  test("renders every option and submits the clicked one", () => {
    const submitted: unknown[] = [];
    const { getByText } = render(
      <AskUserCard
        requestId="req-1"
        questions={questions}
        onSubmit={(requestId, answers) => submitted.push([requestId, answers])}
        onCancel={() => {}}
      />
    );
    expect(getByText("Alpha")).toBeTruthy();
    expect(getByText("Beta")).toBeTruthy();

    fireEvent.click(getByText("Alpha"));
    fireEvent.click(getByText("Submit"));
    expect(submitted).toEqual([
      ["req-1", { "Which draft should I keep?": "Alpha" }],
    ]);
  });

  test("cancelled card collapses to a summary row without options", () => {
    const { queryByText } = render(
      <AskUserCard
        requestId="req-2"
        questions={questions}
        cancelled
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );
    expect(queryByText("Beta")).toBeNull();
  });
});

describe("ZoomViewer", () => {
  test("mounts its content in a portal and closes from the toolbar", () => {
    let closed = 0;
    const { getByText, getByTitle } = render(
      <ZoomViewer onClose={() => closed++}>
        <div>zoomed content</div>
      </ZoomViewer>
    );
    expect(getByText("zoomed content")).toBeTruthy();
    fireEvent.click(getByTitle("Close"));
    expect(closed).toBe(1);
  });
});
