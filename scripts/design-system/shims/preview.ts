// Stand-in for `#.storybook/preview` (CSF factories) so stories bundle without the
// Storybook runtime. Keeps meta/story/extend semantics: args and parameters merge,
// decorators concatenate, the latest render wins. Play functions are kept, never run.
type Any = Record<string, any>;

function merge(a: Any = {}, b: Any = {}): Any {
  const out: Any = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof a[k] === "object" && a[k] && !Array.isArray(a[k]) ? merge(a[k], v) : v;
  }
  return out;
}

function makeStory(meta: Any, input: Any): Any {
  return {
    __bkStory: true,
    meta,
    input,
    extend(next: Any) {
      return makeStory(meta, {
        ...input,
        ...next,
        args: { ...(input.args ?? {}), ...(next.args ?? {}) },
        parameters: merge(input.parameters, next.parameters),
        globals: { ...(input.globals ?? {}), ...(next.globals ?? {}) },
        decorators: [...(input.decorators ?? []), ...(next.decorators ?? [])],
      });
    },
  };
}

const preview = {
  meta(input: Any) {
    return { __bkMeta: true, input, story: (s: Any = {}) => makeStory(input, typeof s === "function" ? { render: s } : s) };
  },
};

export default preview;
