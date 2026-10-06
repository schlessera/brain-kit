// Renders one story of the bundled Storybook into a preview card, composing it the way
// Storybook does: args and parameters merged meta-then-story, story decorators innermost.
import * as React from "react";
import { createRoot } from "react-dom/client";

type Any = Record<string, any>;
export type StoryModule = Record<string, any>;

function storiesOf(mod: StoryModule): [string, Any][] {
  return Object.entries(mod).filter(([k, v]) => k !== "default" && v && v.__bkStory) as [string, Any][];
}

export function listStories(registry: Record<string, StoryModule>) {
  return Object.fromEntries(Object.entries(registry).map(([title, mod]) => [title, storiesOf(mod).map(([n]) => n)]));
}

function merge(a: Any = {}, b: Any = {}): Any {
  const out: Any = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object" ? merge(a[k], v) : v;
  }
  return out;
}

export function StoryView({ story, theme = "dark" }: { story: Any; theme?: string }) {
  const meta = story.meta ?? {};
  const input = story.input ?? {};
  const args = { ...(meta.args ?? {}), ...(input.args ?? {}) };
  const parameters = merge(meta.parameters, input.parameters);
  const context: Any = { args, parameters, globals: { theme, ...(meta.globals ?? {}), ...(input.globals ?? {}) }, argTypes: meta.argTypes ?? {}, title: meta.title, name: input.name, viewMode: "story", loaded: {}, hooks: {} };
  const render = input.render ?? meta.render ?? ((a: Any) => React.createElement(meta.component, a));
  let Inner: React.FC = () => render(args, context);
  for (const dec of [...(input.decorators ?? []), ...(meta.decorators ?? [])]) {
    const Prev = Inner;
    Inner = () => dec(Prev, context);
  }
  return React.createElement(Inner);
}

export function mountStory(registry: Record<string, StoryModule>, el: HTMLElement, title: string, names?: string[]) {
  const mod = registry[title];
  if (!mod) throw new Error(`No story file titled ${title}`);
  const all = storiesOf(mod);
  const picked = names?.length ? all.filter(([n]) => names.includes(n)) : all.slice(0, 1);
  const theme = document.documentElement.getAttribute("data-theme") ?? "dark";
  const nodes = picked.map(([n, s]) =>
    React.createElement(
      "section",
      { key: n, className: "bk-ds-story", "data-story": n },
      picked.length > 1 ? React.createElement("div", { className: "bk-ds-story-name" }, n.replace(/([a-z])([A-Z])/g, "$1 $2")) : null,
      React.createElement(StoryView, { story: s, theme })
    )
  );
  createRoot(el).render(React.createElement(React.Fragment, null, nodes));
}
