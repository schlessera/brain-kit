/** Exact fixture producers and every selected BrowserCommands invocation. */
import {createHash} from "node:crypto";
import {existsSync,readFileSync,realpathSync} from "node:fs";
import {resolve} from "node:path";
import ts from "typescript";
import type {BrowserImporters} from "./bound-browser-runtime-inputs";
const config="packages/ui-kit/vitest.config.ts";
interface DocumentDeclaration { command:string;owner:string;ownerHash:string;caller:string;callerHash:string;calls:number;additionalCallers?:Record<string,{hash:string;calls:number}>;sink:string;producers:Record<string,string>; }
const declarations:DocumentDeclaration[]=[{
  command:"htmlPreviewFixture",owner:"packages/ui-kit/tests/visual/form-browser.ts",ownerHash:"3ccf67a71fa64af195bbf8cf6d173064dc9d2d4fc6abc699fa0a638c352ca62e",
  caller:"packages/ui-react/tests/browser/destination-press.pointer.tsx",callerHash:"85e9a20f9a15dd38a6479e3dd668e45f6f8324c2e6a97a252172392c1bfb857e",calls:2,
  sink:'route.fulfill(requested === path\n      ? { status: 200, contentType: "text/html", body: html }\n      : { status: 404, contentType: "text/plain", body: "Unknown fixture file" })',
  producers:{} as Record<string,string>
},{
  command:"ghostTrace",owner:"packages/ui-kit/tests/visual/ghost-browser.ts",ownerHash:"004c45bd7261997efccc74623ee2f67db4fc832b99039bc2f49cea81e75fb799",
  caller:"packages/ui-kit/tests/visual/ghost-sweep.visual.tsx",callerHash:"77ecc3626f82ae9687f17fdc9846353ed9bd3057a802ac3e8acd89b72d17039e",calls:1,
  sink:'page.setContent(`<html data-theme="${fixture.theme}"><head><base href="${fixture.base}"><style>${fixture.css}</style><style>body{margin:0;padding:16px;box-sizing:border-box;background:var(--bk-color-canvas)}</style></head><body>${fixture.html}</body></html>`)',
  producers:{
    "packages/ui-kit/stories/states/GhostSweep.stories.tsx":"25da76fdba02282bb4ff656da68f27dd1b134d1ed938ceff353ae4c88e0f30b7",
    "packages/ui-kit/.storybook/preview.ts":"bff3b384ba6fd35c4ac6381e2fc125cbeefeda32a58ec3eeef288a19238de0a1",
    "packages/ui-kit/.storybook/preview.css":"d98834fb114fc7aa26cf2b79bcbaf363943fdd99b1535748f14f1dd861a0d4ec",
    "packages/ui-kit/tests/visual/zero-request-replay.ts":"694080b66abfd6235d1873e63c908f4284b8804e5f3ff2ac98ca89169c59290e",
    "packages/ui-kit/tests/visual/design-font-setup.ts":"ef812cb97c62da898dc0050cdfc09762163dfdb2cac1e3b813d586fd0fa95fb2",
    "packages/ui-kit/tests/visual/design-font-checks.ts":"c534a18213734a16731e9ff70aedf267c2fdde6867a17b068b0292040e00634f",
    "packages/ui-kit/tests/visual/rank-footer-browser.ts":"7c4a2b0e4b5d3f40f2cc84af86f852c36068791fcb1dc6f8989f2863d51733a0",
    "scripts/captures/fonts.ts":"a0d96b46f110e929e34cdc592927c4a23dedde9f672e059bfae7bba10e8349cd",
    "scripts/captures/font-lock.json":"3ec58a552059527131bda0277703425243a63aa311d58b67201a7b2c9fe136ad",
    "scripts/captures/fonts.css":"1a6035cc96ef6b928378a04b1f81c13b52362f18fa00e087f4a5f15155482a4d",
    "packages/ui-kit/.storybook/preview-head.html":"66da7597557f1418096239edcd74f7a8decfc70dfc8f1d820de0cf365df41ed7"
  }
},{
  "command": "diagramCapture",
  "owner": "packages/ui-react/tests/browser/diagram-proof-command.ts",
  "ownerHash": "f82b6f8f77d63e000ec2916539201bbda2a29756a734339aa631aa10294fcb64",
  "caller": "packages/ui-react/tests/browser/diagrams-renderer.layout.tsx",
  "callerHash": "1a6c47fb9309628f27294b91b18e014ec1f8e4683849788a40ff88ce04a20278",
  "calls": 2,
  "additionalCallers": {
    "packages/ui-react/tests/browser/diagrams-axis.layout.tsx": {
      "hash": "6512cb4660834ef7b15a52258d51f694c4e34fd530754bdc51580137db22b75c",
      "calls": 3
    },
    "packages/ui-react/tests/browser/diagrams-positional.layout.tsx": {
      "hash": "2d3e72c1b72aff553518bff7f03f99123bd772159f9844f3b68eef025556fbde",
      "calls": 1
    },
    "packages/ui-react/tests/browser/diagrams-node-link.layout.tsx": {
      "hash": "ee5282269f48ed482fc9f3b3316c88b538c7b29772e78f5f87ff27915fa4090f",
      "calls": 2
    }
  },
  "sink": "page.setContent(`<html data-theme=\"${drawing.theme}\"><head><style>${drawing.styles}</style><style>body{margin:0}</style></head><body>${drawing.html}</body></html>`)",
  "producers": {
    "packages/ui-kit/tests/visual/zero-request-replay.ts": "694080b66abfd6235d1873e63c908f4284b8804e5f3ff2ac98ca89169c59290e",
    "packages/ui-kit/tests/visual/form-browser.ts": "3ccf67a71fa64af195bbf8cf6d173064dc9d2d4fc6abc699fa0a638c352ca62e",
    "packages/ui-kit/tests/visual/design-font-setup.ts": "ef812cb97c62da898dc0050cdfc09762163dfdb2cac1e3b813d586fd0fa95fb2",
    "packages/ui-kit/tests/visual/design-font-checks.ts": "c534a18213734a16731e9ff70aedf267c2fdde6867a17b068b0292040e00634f",
    "packages/ui-kit/tests/visual/rank-footer-browser.ts": "7c4a2b0e4b5d3f40f2cc84af86f852c36068791fcb1dc6f8989f2863d51733a0",
    "scripts/captures/fonts.ts": "a0d96b46f110e929e34cdc592927c4a23dedde9f672e059bfae7bba10e8349cd",
    "scripts/captures/font-lock.json": "3ec58a552059527131bda0277703425243a63aa311d58b67201a7b2c9fe136ad",
    "scripts/captures/fonts.css": "1a6035cc96ef6b928378a04b1f81c13b52362f18fa00e087f4a5f15155482a4d",
    "packages/ui-kit/.storybook/preview-head.html": "66da7597557f1418096239edcd74f7a8decfc70dfc8f1d820de0cf365df41ed7",
    "packages/module-diagrams/tests/fixtures/renderer-fixture.ts": "dc0db9aba9cd425c0cb12bd0241c6d9b4d8edd4a1ed6270e391f9d0cae7018be",
    "packages/module-diagrams/tests/fixtures/adopted-homecoming-relay.diagram.yaml": "bc5d906627a8392da7921f8d74ff72eb7de4fb9cf03879fc6c83b1aaec0ee3a4",
    "packages/module-diagrams/src/axis-check.ts": "ba2133b3c42bcd72abcdb7200ba4fd4a05656aee0028b7894db7a22bcafbdbe9",
    "packages/module-diagrams/src/axis-layout.ts": "969b035e0cccb2bb63dabd403561efa41fc597af9b1537c29a3e9f60cd987bb9",
    "packages/module-diagrams/src/axis-spec.ts": "55bce9fad9e94af099a55fb1f7d282247c4b5f0dbdd9b33679e2903acfc28b93",
    "packages/module-diagrams/src/shape-svg.ts": "b629406bfec41e3ed9973a395a6271d69f1ce45d823591ab15b5581a0116a29b",
    "packages/module-diagrams/src/shape.ts": "126cb4f530ea60736764c1237cc33a944ef924d62d74ba404e9b97d9f1e2696e",
    "packages/module-diagrams/tests/fixtures/axis-examples.ts": "3925e82b8bc2ced444d8d6019fa13a93396315438e6e1c426fd338cc42685d2e",
    "packages/module-diagrams/src/skin.generated.ts": "3c78137114fdb7ac4d376bec30c871c57ebba64fe3872427807a8b4e77200996",
    "packages/module-diagrams/src/check.ts": "9238125bac6b97809e34d4079af31e242c848a553b38e2415fa3b91b0bc7a96d",
    "packages/module-diagrams/src/svg-model.ts": "f5032f9c58a7878f175e2f34623d90f819c01f20c60f2555a7574713514b9dcf",
    "packages/module-diagrams/src/geometry.ts": "f3b77d04e97a26d3351eb64c44550d27e60fc22bb1200a3c91412aec0ad50932",
    "packages/module-diagrams/src/drawing-style.ts": "9d9108f2e8fdf5c416d1deee3ecc8d4f4ad709956a15ffcdb0a1b3a07919cfe5",
    "packages/module-diagrams/src/ui.tsx": "c407b4159ba4ff97d0dc30ad0b22845f60a1740e2caadffe44417a7d7a1a8386",
    "packages/module-diagrams/src/layout.ts": "89ae43c33902768a71541b917bfda9e3e89c246a7757ee7b1a151b619272c896",
    "packages/module-diagrams/src/skin.ts": "7d49130676a58726964c29d13158b93327f7259855f8dd748a5fe07039e05de6",
    "packages/module-diagrams/src/render.ts": "cca2cac8310060a9be4aa5f5fba72b1a16bc58fdc6158b71c7b2d854d07c2d71",
    "packages/module-diagrams/src/spec.ts": "9b58a0da4b74e69abbc03a6bab0785dcc23bd401b809d9495e4a6a4ceeb9a01f",
    "packages/module-diagrams/src/positional-check.ts": "50736c5283fdefbe9c0b501fb385445e3092867ad93cf6e3aa744f4aedae1e4e",
    "packages/module-diagrams/src/positional-layout.ts": "2d46fa8710bab9f3b512733d1e2ad2fe4b3b1189f2438937903df55437d53a49",
    "packages/module-diagrams/src/positional-spec.ts": "2ab49b3b1f68610a4fea8ac90cde0a34ac96e099d21f7d3383fa72b44ce64a87",
    "packages/module-diagrams/src/containment.ts": "bb8ce8a46399e86e779d95c79c26e72db2d0005a9f517bcb86d0d4f0d79f4a24",
    "packages/module-diagrams/src/node-link-check.ts": "8d79f23079a7c9e0592315ae37515fcf92af9c70a1992cbf52ba9d6032fff3eb",
    "packages/module-diagrams/src/node-link-svg.ts": "58865c81cea002b7373d54d68ef350bf5d436efd7c3b185336a6492bec784b9d",
    "packages/module-diagrams/skills/diagram/references/examples/positional/flywheel.diagram.yaml": "7f0a2e0a6a568bbebb9e93f8df920a7bb1a4592b0863df7169af007188f75519",
    "packages/module-diagrams/skills/diagram/references/examples/positional/funnel.diagram.yaml": "f07c66e0884e43480e2433a38f46b1c30920f63b160c11d731e4dbe360c0bb3a",
    "packages/module-diagrams/skills/diagram/references/examples/positional/layer-stack.diagram.yaml": "7de880f4a717ab37174fbb07554d23d6cc97c28cce2a6b7841ec2a2e02ee8ec5",
    "packages/module-diagrams/skills/diagram/references/examples/positional/loop.diagram.yaml": "f646cc67dc0f1e74638fe508e43b777853247a2befd0acdb0c763c88cedaf725",
    "packages/module-diagrams/skills/diagram/references/examples/positional/pyramid.diagram.yaml": "b400671e033ab21d8d076b11a0011f4c2ae402d394d95b4a441ff974eede07f1",
    "packages/module-diagrams/skills/diagram/references/examples/positional/quadrant.diagram.yaml": "a34c654a0c4894cae18dc5a19d656bd69c08cf5422cef120f2c0b539ed7d7175",
    "packages/module-diagrams/skills/diagram/references/examples/positional/venn.diagram.yaml": "a762f39dfa71cfc559ecf15b659bca094c5c9f7797e9147cc668bcdbccc987a3",
    "packages/module-diagrams/skills/diagram/references/examples/architecture.diagram.yaml": "0c6d9a736fb3337f58b2430afc35b7bb597e42fd97d252b80ff721bb9bddaa8a",
    "packages/module-diagrams/skills/diagram/references/examples/flowchart.diagram.yaml": "46ab66859d500bb36e327adc73375b9f48461ea2137ce24c87226b9aaaa41a97",
    "packages/module-diagrams/skills/diagram/references/examples/state-machine.diagram.yaml": "2411a0e1bff9509f4fe3dad2fdfd92b55a9886e59520dbead6302b43ca00a964",
    "packages/module-diagrams/skills/diagram/references/examples/tree.diagram.yaml": "005933705b5836ef083761d47c8ff52eec644618ee07ef726fc807a8f418c29e",
    "packages/module-diagrams/skills/diagram/references/examples/er.diagram.yaml": "c28b51b3aa3f177c90e4df088edca9da918034a16721d1afde6373495771bd4a",
    "packages/module-diagrams/skills/diagram/references/examples/dependency.diagram.yaml": "d5474b1abf5b11ad5826c099f4fbf2d33ca0e44b2b10eca287056da73f0102ad",
    "packages/module-diagrams/skills/diagram/references/examples/architecture-containment.diagram.yaml": "8efc225957ba0fa6a51802448098895de838fa75087f3b4202df8196d0c622fc"
  }
},
{
  "command": "diagramRasterComparison",
  "owner": "packages/ui-react/tests/browser/diagram-export-command.ts",
  "ownerHash": "c677a88109878e075ffa565dd21849a1598199a770d77fe69794909f3b2db134",
  "caller": "packages/ui-react/tests/browser/diagrams-export.layout.tsx",
  "callerHash": "2730c38d2b808280c8798cc33adceee54f3c3b7e0a6beff2d2066552d8fceb9f",
  "calls": 3,
  "sink": "page.setContent(`<!doctype html><html><body style=\"margin:0\">${html}</body></html>`)",
  "producers": {
    "packages/ui-kit/tests/visual/zero-request-replay.ts": "694080b66abfd6235d1873e63c908f4284b8804e5f3ff2ac98ca89169c59290e",
    "packages/ui-kit/tests/visual/form-browser.ts": "3ccf67a71fa64af195bbf8cf6d173064dc9d2d4fc6abc699fa0a638c352ca62e",
    "packages/ui-kit/tests/visual/design-font-setup.ts": "ef812cb97c62da898dc0050cdfc09762163dfdb2cac1e3b813d586fd0fa95fb2",
    "packages/ui-kit/tests/visual/design-font-checks.ts": "c534a18213734a16731e9ff70aedf267c2fdde6867a17b068b0292040e00634f",
    "packages/ui-kit/tests/visual/rank-footer-browser.ts": "7c4a2b0e4b5d3f40f2cc84af86f852c36068791fcb1dc6f8989f2863d51733a0",
    "scripts/captures/fonts.ts": "a0d96b46f110e929e34cdc592927c4a23dedde9f672e059bfae7bba10e8349cd",
    "scripts/captures/font-lock.json": "3ec58a552059527131bda0277703425243a63aa311d58b67201a7b2c9fe136ad",
    "scripts/captures/fonts.css": "1a6035cc96ef6b928378a04b1f81c13b52362f18fa00e087f4a5f15155482a4d",
    "packages/ui-kit/.storybook/preview-head.html": "66da7597557f1418096239edcd74f7a8decfc70dfc8f1d820de0cf365df41ed7",
    "packages/module-diagrams/tests/fixtures/renderer-fixture.ts": "dc0db9aba9cd425c0cb12bd0241c6d9b4d8edd4a1ed6270e391f9d0cae7018be",
    "packages/module-diagrams/tests/fixtures/adopted-homecoming-relay.diagram.yaml": "bc5d906627a8392da7921f8d74ff72eb7de4fb9cf03879fc6c83b1aaec0ee3a4",
    "packages/module-diagrams/src/axis-check.ts": "ba2133b3c42bcd72abcdb7200ba4fd4a05656aee0028b7894db7a22bcafbdbe9",
    "packages/module-diagrams/src/axis-layout.ts": "969b035e0cccb2bb63dabd403561efa41fc597af9b1537c29a3e9f60cd987bb9",
    "packages/module-diagrams/src/axis-spec.ts": "55bce9fad9e94af099a55fb1f7d282247c4b5f0dbdd9b33679e2903acfc28b93",
    "packages/module-diagrams/src/shape-svg.ts": "b629406bfec41e3ed9973a395a6271d69f1ce45d823591ab15b5581a0116a29b",
    "packages/module-diagrams/src/shape.ts": "126cb4f530ea60736764c1237cc33a944ef924d62d74ba404e9b97d9f1e2696e",
    "packages/module-diagrams/tests/fixtures/axis-examples.ts": "3925e82b8bc2ced444d8d6019fa13a93396315438e6e1c426fd338cc42685d2e",
    "packages/module-diagrams/src/skin.generated.ts": "3c78137114fdb7ac4d376bec30c871c57ebba64fe3872427807a8b4e77200996",
    "packages/module-diagrams/src/check.ts": "9238125bac6b97809e34d4079af31e242c848a553b38e2415fa3b91b0bc7a96d",
    "packages/module-diagrams/src/svg-model.ts": "f5032f9c58a7878f175e2f34623d90f819c01f20c60f2555a7574713514b9dcf",
    "packages/module-diagrams/src/geometry.ts": "f3b77d04e97a26d3351eb64c44550d27e60fc22bb1200a3c91412aec0ad50932",
    "packages/module-diagrams/src/drawing-style.ts": "9d9108f2e8fdf5c416d1deee3ecc8d4f4ad709956a15ffcdb0a1b3a07919cfe5",
    "packages/module-diagrams/src/ui.tsx": "c407b4159ba4ff97d0dc30ad0b22845f60a1740e2caadffe44417a7d7a1a8386",
    "packages/module-diagrams/src/layout.ts": "89ae43c33902768a71541b917bfda9e3e89c246a7757ee7b1a151b619272c896",
    "packages/module-diagrams/src/skin.ts": "7d49130676a58726964c29d13158b93327f7259855f8dd748a5fe07039e05de6",
    "packages/module-diagrams/src/render.ts": "cca2cac8310060a9be4aa5f5fba72b1a16bc58fdc6158b71c7b2d854d07c2d71",
    "packages/module-diagrams/src/spec.ts": "9b58a0da4b74e69abbc03a6bab0785dcc23bd401b809d9495e4a6a4ceeb9a01f",
    "packages/module-diagrams/src/positional-check.ts": "50736c5283fdefbe9c0b501fb385445e3092867ad93cf6e3aa744f4aedae1e4e",
    "packages/module-diagrams/src/positional-layout.ts": "2d46fa8710bab9f3b512733d1e2ad2fe4b3b1189f2438937903df55437d53a49",
    "packages/module-diagrams/src/positional-spec.ts": "2ab49b3b1f68610a4fea8ac90cde0a34ac96e099d21f7d3383fa72b44ce64a87",
    "packages/module-diagrams/src/containment.ts": "bb8ce8a46399e86e779d95c79c26e72db2d0005a9f517bcb86d0d4f0d79f4a24",
    "packages/module-diagrams/src/node-link-check.ts": "8d79f23079a7c9e0592315ae37515fcf92af9c70a1992cbf52ba9d6032fff3eb",
    "packages/module-diagrams/src/node-link-svg.ts": "58865c81cea002b7373d54d68ef350bf5d436efd7c3b185336a6492bec784b9d",
    "packages/module-diagrams/skills/diagram/references/examples/positional/flywheel.diagram.yaml": "7f0a2e0a6a568bbebb9e93f8df920a7bb1a4592b0863df7169af007188f75519",
    "packages/module-diagrams/skills/diagram/references/examples/positional/funnel.diagram.yaml": "f07c66e0884e43480e2433a38f46b1c30920f63b160c11d731e4dbe360c0bb3a",
    "packages/module-diagrams/skills/diagram/references/examples/positional/layer-stack.diagram.yaml": "7de880f4a717ab37174fbb07554d23d6cc97c28cce2a6b7841ec2a2e02ee8ec5",
    "packages/module-diagrams/skills/diagram/references/examples/positional/loop.diagram.yaml": "f646cc67dc0f1e74638fe508e43b777853247a2befd0acdb0c763c88cedaf725",
    "packages/module-diagrams/skills/diagram/references/examples/positional/pyramid.diagram.yaml": "b400671e033ab21d8d076b11a0011f4c2ae402d394d95b4a441ff974eede07f1",
    "packages/module-diagrams/skills/diagram/references/examples/positional/quadrant.diagram.yaml": "a34c654a0c4894cae18dc5a19d656bd69c08cf5422cef120f2c0b539ed7d7175",
    "packages/module-diagrams/skills/diagram/references/examples/positional/venn.diagram.yaml": "a762f39dfa71cfc559ecf15b659bca094c5c9f7797e9147cc668bcdbccc987a3",
    "packages/module-diagrams/skills/diagram/references/examples/architecture.diagram.yaml": "0c6d9a736fb3337f58b2430afc35b7bb597e42fd97d252b80ff721bb9bddaa8a",
    "packages/module-diagrams/skills/diagram/references/examples/flowchart.diagram.yaml": "46ab66859d500bb36e327adc73375b9f48461ea2137ce24c87226b9aaaa41a97",
    "packages/module-diagrams/skills/diagram/references/examples/state-machine.diagram.yaml": "2411a0e1bff9509f4fe3dad2fdfd92b55a9886e59520dbead6302b43ca00a964",
    "packages/module-diagrams/skills/diagram/references/examples/tree.diagram.yaml": "005933705b5836ef083761d47c8ff52eec644618ee07ef726fc807a8f418c29e",
    "packages/module-diagrams/skills/diagram/references/examples/er.diagram.yaml": "c28b51b3aa3f177c90e4df088edca9da918034a16721d1afde6373495771bd4a",
    "packages/module-diagrams/skills/diagram/references/examples/dependency.diagram.yaml": "d5474b1abf5b11ad5826c099f4fbf2d33ca0e44b2b10eca287056da73f0102ad",
    "packages/module-diagrams/skills/diagram/references/examples/architecture-containment.diagram.yaml": "8efc225957ba0fa6a51802448098895de838fa75087f3b4202df8196d0c622fc",
    "packages/module-diagrams/src/flatten.ts": "5ac2803560443bb98eb4284146209c09cbd328d57e83ddaa1807f4c3b34138da",
    "packages/module-diagrams/src/fonts.ts": "e575dbabbaa452f22389e61770b02200e78b965018f61662573f985024801419",
    "packages/module-diagrams/assets/fonts/2.ttf": "44ce4a84f20d60f24539bd0cef11f79c29e38609e0f8adf18551c9794a5d9dc3",
    "packages/module-diagrams/assets/fonts/4.ttf": "df54dbfafba61d4911eb3dab9bba2d20531fb009f01d64dd42fa96ab862584d8",
    "packages/module-diagrams/assets/fonts/6.ttf": "b4fc14ec283d54236fd302cdb92546f98ae0ff061ca5ee23453a02bdf4628791",
    "packages/module-diagrams/assets/fonts/7.ttf": "50357df108c5d297ec4ece76aeddf49561f3794f67af077cfc2c711b7a75b439"
  }
}];
export interface BrowserDocumentInputs {runtime:string[];bytes:string[];}
/** Requires a successful complete activation audit; aliases/loaders are checked
 * there. All producers/dependencies retain normal input traversal here.
 */
export function boundBrowserDocuments(root:string,files:readonly string[],importers:BrowserImporters):Map<string,Map<string,BrowserDocumentInputs>>{
  const result=new Map<string,Map<string,BrowserDocumentInputs>>();
  const matches=(file:string,hash:string)=>{const path=resolve(root,file);return existsSync(path)&&realpathSync(path)===path&&createHash("sha256").update(readFileSync(path)).digest("hex")===hash;};
  if(!matches(config,"e724696a55955e9f32d396b2031214600086533c3f9b8baabcc1c6bb7311f1db"))return result;
  for(const declaration of declarations){
    const callers=new Map<string,{hash:string;calls:number}>([[declaration.caller,{hash:declaration.callerHash,calls:declaration.calls}],...Object.entries(declaration.additionalCallers??{})]);
    if(![config,declaration.owner,...callers.keys()].every(file=>files.includes(file))||!matches(declaration.owner,declaration.ownerHash)||[...callers].some(([file,entry])=>!matches(file,entry.hash))||Object.entries(declaration.producers).some(([file,hash])=>!matches(file,hash))||[...(importers.get(declaration.owner)??[])].some(file=>file!==config))continue;
    const counts=new Map([...callers.keys()].map(file=>[file,0]));let unsafe=false;
    for(const file of files){
      if(!/\.[cm]?[jt]sx?$/.test(file))continue;
      const source=ts.createSourceFile(file,readFileSync(resolve(root,file),"utf8"),ts.ScriptTarget.Latest,true),names=new Set<string>();
      for(const statement of source.statements)if(ts.isImportDeclaration(statement)&&ts.isStringLiteral(statement.moduleSpecifier)&&statement.moduleSpecifier.text==="vitest/browser"){
        const bindings=statement.importClause?.namedBindings;
        if(bindings&&ts.isNamedImports(bindings))for(const binding of bindings.elements)if((binding.propertyName?.text??binding.name.text)==="commands")names.add(binding.name.text);
      }
      const bindings=(node:ts.Node)=>{
        if(ts.isVariableDeclaration(node)&&ts.isObjectBindingPattern(node.name)&&node.initializer&&ts.isAwaitExpression(node.initializer)&&ts.isCallExpression(node.initializer.expression)&&node.initializer.expression.expression.kind===ts.SyntaxKind.ImportKeyword){
          const literal=node.initializer.expression.arguments[0];
          if(literal&&ts.isStringLiteral(literal)&&literal.text==="vitest/browser")for(const binding of node.name.elements)if(ts.isIdentifier(binding.name)&&(binding.propertyName?.getText(source)??binding.name.text)==="commands")names.add(binding.name.text);
        }
        ts.forEachChild(node,bindings);
      };bindings(source);
      const walk=(node:ts.Node)=>{
        if(ts.isPropertyAccessExpression(node)&&ts.isIdentifier(node.expression)&&names.has(node.expression.text)&&node.name.text===declaration.command){
          if(!callers.has(file)||!ts.isCallExpression(node.parent)||node.parent.expression!==node)unsafe=true;else counts.set(file,counts.get(file)!+1);
        }
        ts.forEachChild(node,walk);
      };walk(source);
    }
    // Form: cleanup(null), literal paragraphs and a reporting/scroll script.
    // Ghost: argument-free call immediately after the exact Performance story;
    // all replay network attempts abort and fail before/after fonts and trace.
    const producers=Object.keys(declaration.producers);
    if(!unsafe&&[...callers].every(([file,entry])=>counts.get(file)===entry.calls))result.set(declaration.owner,new Map([[declaration.sink,{runtime:[...callers.keys(),...producers.filter(file=>/\.[cm]?[jt]sx?$/.test(file))],bytes:producers.filter(file=>!/\.[cm]?[jt]sx?$/.test(file))}]]));
  }
  return result;
}
