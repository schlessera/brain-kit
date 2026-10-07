import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { expect, waitFor } from "storybook/test";
import preview from "#.storybook/preview";
import { BrainUiProvider } from "../../../ui-react/src/root-context.js";
import { createBrainUiRoot } from "../../../ui-react/src/root.js";
import { BrainMarkdown } from "../../../ui-react/src/components/chat/brain-markdown.js";
import consumerStyles from "../../../ui-react/dist/styles.css?raw";
import { stage, wide } from "../_stage.js";

const code = '// The crossing remains visible.\nfunction crossing(crew) {\n  const guide = "Circe";\n  return crew === 24 && true ? /scylla/i : null;\n}';
const source = '```js\n' + code + '\n```\n\n```diff\n- Risk six men.\n+ Keep the crossing visible.\n```\n\n```\nbrain search "Scylla" --path knowledge/scylla.md --json\n```';
/** The actual consumer renderer and shipped stylesheet, scoped away from the
 * kit's different Tailwind spacing. Toolbar themes inherit into the shadow. */
function CodeFenceTheme() {
  const mount = useRef<HTMLDivElement>(null);
  const [shadow, setShadow] = useState<ShadowRoot | null>(null);
  const [root] = useState(() => createBrainUiRoot({ storage: null }));
  useEffect(() => { setShadow(mount.current!.shadowRoot ?? mount.current!.attachShadow({ mode: "open" })); return () => root.dispose(); }, [root]);
  return <div ref={mount} data-code-theme-preview style={{ width: "100%" }}>{shadow ? createPortal(<>
    <style>{consumerStyles}</style><BrainUiProvider root={root}><BrainMarkdown content={source}/></BrainUiProvider>
  </>, shadow) : null}</div>;
}
const meta = preview.meta({ title: "Conversation/Code fence theme", component: CodeFenceTheme, decorators: [stage], parameters: { stageWidth: 320 } });
export const Phone = meta.story({ render: () => <CodeFenceTheme/>, play: async ({ canvasElement }) => {
  await waitFor(() => expect(canvasElement.querySelector('[data-code-theme-preview]')?.shadowRoot?.querySelectorAll('.hljs-keyword').length ?? 0).toBeGreaterThan(0));
  const shadow = canvasElement.querySelector('[data-code-theme-preview]')!.shadowRoot!;
  await expect(shadow.querySelectorAll('[data-kit-code-block]')).toHaveLength(3);
  for (const button of shadow.querySelectorAll('button')) await expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
} });
export const Desktop = Phone.extend({ parameters: wide });
