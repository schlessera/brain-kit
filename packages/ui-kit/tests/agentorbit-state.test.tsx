import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentOrbit, type AgentOrbitProps } from "../src/agents/AgentOrbit.js";
import { AgentRunCard } from "../src/agents/AgentRunCard.js";

test("no sample agents for a JavaScript caller with absent data", () => {
  const html = renderToStaticMarkup(<AgentOrbit {...({} as AgentOrbitProps)}/>);
  expect(html).not.toContain("researcher");
  expect(html).toBe("");
});
test("an empty orbit invents neither agents nor corpus counts", () => {
  expect(renderToStaticMarkup(<AgentOrbit agents={[]}/>)).toBe("");
});
test("stopped AgentRunCard is neutral and does not pulse", () => {
  const html = renderToStaticMarkup(<AgentRunCard agent="source-watch" state="stopped" task="Check the crossing." meta="cancelled" progress={null}/>);
  expect(html).toContain("cancelled");
  expect(html).not.toContain("breathe");
  expect(html).toContain("var(--bk-neutral-mark)");
});
