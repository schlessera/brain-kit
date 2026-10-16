/** Offline review captures only. No product or token implementation. */
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,'../../..');
const cache=process.argv[2]??'/tmp/2091-font-cache';
const review=process.argv[3]??'/tmp/2091-review-artifacts';
await mkdir(review,{recursive:true});
const lock=JSON.parse(await readFile(resolve(root,'scripts/captures/font-lock.json'),'utf8'));
let fonts=await readFile(resolve(root,lock.stylesheet.file),'utf8');
for(const entry of lock.assets){
 const bytes=await readFile(resolve(cache,entry.file));
 if(bytes.length!==entry.bytes||createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error('Font checksum mismatch');
 fonts=fonts.replaceAll(entry.url,'data:font/ttf;base64,'+bytes.toString('base64'));
}
const colors={light:{canvas:'#ece7dc',bg:'#f8f5ef',node:'#fffefa',text:'#231f1a',mute:'#5f584c',line:'#5f584c',blue:'#1a5c7f'},dark:{canvas:'#0c0e12',bg:'#141619',node:'#1e2128',text:'#e8e4df',mute:'#9a96a1',line:'#9a96a1',blue:'#67b8e3'},print:{canvas:'#fff',bg:'#fff',node:'#fff',text:'#231f1a',mute:'#5f584c',line:'#5f584c',blue:'#1a5c7f'}};
function shell(mode,width,content,narrow=false){
 const p=colors[mode];
 return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}
 *{box-sizing:border-box}body{margin:0;background:${p.canvas};color:${p.text};font-family:'Plus Jakarta Sans',sans-serif;width:${width}px;padding:${narrow?0:24}px}header{padding:${narrow?'20px 16px 16px':'0 0 14px'}}.eyebrow{font:600 9.5px/1.6 'JetBrains Mono',monospace;letter-spacing:.855px;color:${p.mute};text-transform:uppercase}h1{font:400 18px/1.3 'DM Serif Text',serif;margin:6px 0 0}svg{display:block;max-width:none}p{font-size:12px;line-height:1.65;margin:12px 0}.fallback{margin:0 16px 20px;padding:16px;background:${p.bg};border:1px solid ${p.line};border-radius:8px}.open{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;height:44px;border:1px solid ${p.line};border-radius:5px;background:${p.node};color:${p.text};font-size:12px;font-weight:600;text-decoration:none}.open span{font-size:16px;color:${p.blue}}.hint{font:400 10px/1.6 'JetBrains Mono',monospace;color:${p.mute};margin:10px 0 0}.viewer{border-top:1px solid ${p.line};background:${p.bg};overflow:hidden}.toolbar{height:48px;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:600}.crop{width:320px;height:320px;overflow:hidden}.crop svg{transform:translate(-216px,-48px)}.viewer .hint{padding:12px 16px}
 </style><header><div class="eyebrow">Architecture · 06:40 Ogygia ${narrow?'<br>':'· '}2026-07-12</div><h1>The homecoming relay</h1></header>${content}`;
}
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const receipts=[];
try{
 for(const mode of ['light','dark','print'])for(const layout of ['desktop','narrow']){
  const name=`relay-${layout}-${mode}`;const svg=await readFile(resolve(here,name+'.svg'),'utf8');
  const narrow=layout==='narrow',width=narrow?320:768;
  const html=shell(mode,width,svg,narrow);await writeFile(resolve(review,name+'.html'),html);await copyFile(resolve(here,name+'.svg'),resolve(review,name+'.svg'));
  const page=await browser.newPage({viewport:{width,height:1300},deviceScaleFactor:2});
  await page.route('**/*',route=>route.abort());
  await page.setContent(html);await page.evaluate(()=>document.fonts.ready);
  const measured=await page.evaluate(()=>{
   const svg=document.querySelector('svg'),root=svg.getBoundingClientRect();
   const text=[...svg.querySelectorAll('[data-node] text')].map(el=>{const b=el.getBBox(),n=el.closest('[data-node]'),r=n.querySelector('rect');return{node:n.dataset.node,text:el.textContent,size:parseFloat(getComputedStyle(el).fontSize),family:getComputedStyle(el).fontFamily,right:b.x+b.width,nodeRight:r.x.baseVal.value+r.width.baseVal.value}});
   return {nodes:svg.querySelectorAll('[data-node]').length,edges:svg.querySelectorAll('[data-edge]').length,renderedWidth:root.width,minimumFont:Math.min(...text.map(t=>t.size)),text,fonts:[document.fonts.check('600 12px "Plus Jakarta Sans"'),document.fonts.check('400 10px "JetBrains Mono"'),document.fonts.check('400 18px "DM Serif Text"')],documentOverflow:document.documentElement.scrollWidth>innerWidth};
  });
  if(measured.nodes!==8||measured.edges!==7||measured.minimumFont<9||measured.documentOverflow||measured.fonts.some(v=>!v)||measured.text.some(t=>t.right>t.nodeRight-6))throw Error(name+' invalid layout: '+JSON.stringify(measured));
  await page.setViewportSize({width,height:Math.ceil(await page.locator('body').evaluate(e=>e.scrollHeight))});
  await page.screenshot({path:resolve(here,name+'.png'),fullPage:true});await copyFile(resolve(here,name+'.png'),resolve(review,name+'.png'));
  receipts.push({name,...measured});await page.close();
 }
 const focusSvg=await readFile(resolve(here,'relay-desktop-focus-light.svg'),'utf8');
 for(const mode of ['light','dark']){
  const svg=await readFile(resolve(here,`relay-desktop-${mode}.svg`),'utf8');
  const content=`<section class="fallback"><div class="eyebrow">Diagram summary</div><p>Captures from Odysseus’s phone and News from Sparta via source-watch enter the inbox. note-filer updates the crew ledger and voyage notes, then sends Penelope the morning digest.</p><a class="open" href="#viewer">Open diagram <span aria-hidden="true">↗</span></a><p class="hint">No narrow layout supplied.<br>The viewer keeps the text readable.</p></section><section class="viewer" id="viewer" aria-label="Dedicated viewer illustration"><div class="toolbar"><span>Diagram viewer</span><span>− &nbsp; 100% &nbsp; +</span></div><div class="crop">${svg}</div><p class="hint">Dedicated viewer · 1:1 text<br>Pan to explore; zoom is explicit.</p></section>`;
  const html=shell(mode,320,content,true),page=await browser.newPage({viewport:{width:320,height:900},deviceScaleFactor:2});await page.route('**/*',r=>r.abort());await page.setContent(html);await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:resolve(here,`absent-narrow-${mode}.png`),fullPage:true});await copyFile(resolve(here,`absent-narrow-${mode}.png`),resolve(review,`absent-narrow-${mode}.png`));await writeFile(resolve(review,`absent-narrow-${mode}.html`),html);await page.close();
 }
 const page=await browser.newPage({viewport:{width:768,height:700},deviceScaleFactor:2});await page.route('**/*',r=>r.abort());await page.setContent(shell('light',768,focusSvg));await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:resolve(here,'relay-desktop-focus-light.png'),fullPage:true});await copyFile(resolve(here,'relay-desktop-focus-light.png'),resolve(review,'relay-desktop-focus-light.png'));await copyFile(resolve(here,'relay-desktop-focus-light.svg'),resolve(review,'relay-desktop-focus-light.svg'));await writeFile(resolve(review,'relay-desktop-focus-light.html'),shell('light',768,focusSvg));await page.close();
}finally{await browser.close()}
await writeFile(resolve(here,'browser-validation.json'),JSON.stringify({fontLockSha256:createHash('sha256').update(await readFile(resolve(root,'scripts/captures/font-lock.json'))).digest('hex'),offline:true,captures:receipts},null,2)+'\n');
console.log(`Rendered ${receipts.length} theme/layout figures, focal state and two fallback/viewer illustrations; fonts, bounds and native320px width verified.`);
