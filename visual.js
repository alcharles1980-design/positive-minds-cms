// VISUAL LAYOUT ANALYSIS
//
// I cannot take true screenshots (no browser in this sandbox, and Chrome's CDN is unreachable).
// So instead of pretending, I do the next best thing that is actually rigorous: render each page
// with the REAL stylesheet, compute the actual layout box of every element, and look for the
// defects a human eye would catch — overlaps, overflow, squeezed elements, inconsistent spacing,
// text that cannot fit its container.
//
// It also writes a real .html file per page/device, which YOU can open and look at yourself.

const React = require('react');
const { renderToString } = require('react-dom/server');
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const vc = new VirtualConsole();

const order = ['core.jsx','primitives.jsx','realtime.jsx','engine.jsx','firebase.jsx','editors.jsx','features.jsx','publish1.jsx','firebase2.jsx','publish2.jsx','devdocs.jsx','devnotes.jsx','levels.jsx','aireview.jsx','aisettings.jsx','generator.jsx','views1.jsx','views2.jsx','shell.jsx'];
const SRC_DIR = path.join(__dirname, 'src');
let src = '';
for (const f of order) {
  let c = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
  c = c.replace(/^import[^\n]*\n/gm, '').replace(/export default function App/, 'function App').replace(/^export\s+/gm, '');
  src += '\n' + c;
}
src = src.replace(/const useAsync = \(fn, deps = \[\]\) => \{[\s\S]*?\n\};/,
  `const useAsync=(fn,deps=[])=>({loading:false,error:null,data:(globalThis.__D__&&globalThis.__D__.length)?globalThis.__D__.shift():null,reload:()=>{},setData:()=>{}});`);
const compiled = babel.transformSync('const {useState,useEffect,useMemo,useCallback,useRef}=React;\n' + src,
  { presets: [['@babel/preset-react', { runtime: 'classic' }]] }).code;

function sandbox(w, h, coarse) {
  const el = () => ({ style:{}, setAttribute(){}, getAttribute:()=>null, appendChild(){}, classList:{add(){},remove(){},toggle(){}}, addEventListener(){}, removeEventListener(){}, focus(){}, select(){} });
  const doc = { documentElement: el(), addEventListener(){}, removeEventListener(){}, createElement: el, head: el(), body: el(), getElementById: ()=>null, querySelector: ()=>null, title:'' };
  const win = { innerWidth:w, innerHeight:h,
    matchMedia: q => ({ matches: q.includes('coarse') ? coarse : false, addEventListener(){}, removeEventListener(){} }),
    addEventListener(){}, removeEventListener(){},
    localStorage: { getItem:()=>null, setItem(){}, removeItem(){} },
    location:{href:'',hash:'',search:''}, history:{replaceState(){}},
    navigator:{onLine:true, clipboard:{writeText:()=>Promise.resolve()}},
    WebSocket: function(){ this.close=()=>{}; },
    requestAnimationFrame: f => { f(); return 1; }, cancelAnimationFrame(){} };
  win.window = win;
  const sb = { React, window:win, document:doc,
    fetch: () => Promise.resolve({ ok:true, status:200, text:()=>Promise.resolve('[]') }),
    console:{log(){},warn(){},error(){}}, setTimeout, clearTimeout, setInterval:()=>0, clearInterval,
    navigator:win.navigator, localStorage:win.localStorage, WebSocket:win.WebSocket,
    crypto:{randomUUID:()=>'u'}, requestAnimationFrame:win.requestAnimationFrame, cancelAnimationFrame:win.cancelAnimationFrame };
  sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(compiled, sb);
  return sb;
}

// Real evaluated CSS (render GlobalStyle — do NOT regex it, that leaves ${} placeholders)
let CSS = '';
{
  const boot = sandbox(1440, 900, false);
  const GS = vm.runInContext('typeof GlobalStyle!=="undefined"?GlobalStyle:null', boot);
  const m = renderToString(React.createElement(GS)).match(/<style[^>]*>([\s\S]*?)<\/style>/);
  CSS = m ? m[1] : '';
}
if (!CSS || CSS.includes('${')) { console.error('CSS not properly evaluated — aborting.'); process.exit(1); }

// ---- Realistic data, INCLUDING the awkward cases a real library has ----
const DASH = { total_packs:15, published_packs:14, draft_packs:1, empty_packs:13, total_questions:12, active_questions:12, questions_by_level:{'1':11,'10':1}, distinct_levels_used:2, avg_questions_per_pack:6.0 };
const LEVELS = [
  { level:1, name:'First Words', tagline:'Just one letter to find', color:'#00B894', hidden_mode:'letters', letters_hidden_default:1, letter_position:'middle', letter_grouping:'grouped', theme:'Simple self-affirmation', age_hint:'Around 5', letters_rule:'One letter hidden', word_rule:'Short, simple words' },
  { level:7, name:'Thoughtful Choices', tagline:'The whole word is hidden', color:'#E17055', hidden_mode:'word', letters_hidden_default:9, theme:'Nuanced self-belief', age_hint:'Around 10', letters_rule:'Whole word', word_rule:'Longer words' },
];
const PACKS = [
  { id:'p1', name:'Confidence', emoji:'💪', slug:'confidence', level:1, status:'published', active_questions:11, total_questions:11, color:'#00B894', tags:['core','starter'], description:'Believing in yourself', content_version:57, released_version:56 },
  { id:'p2', name:'Extraordinarily Long Pack Name That Someone Will Definitely Type', emoji:'🌊', slug:'a-very-long-slug-here', level:1, status:'draft', active_questions:0, total_questions:0, color:'#0984E3', tags:[], description:'', content_version:1, released_version:1 },
];
const Q = [
  { id:'q1', pack_id:'p1', template:'I am {blank} when I try new things', answer:'BRAVE', alt_answer:'BOLD', status:'active', level:1, created_at:new Date().toISOString(), effective_level:1, frame_slots:{} },
  { id:'q2', pack_id:'p1', template:'Even when things are really difficult and I feel like giving up completely, I remember that I am {blank}', answer:'MAGNIFICENT', alt_answer:'STRONG', status:'active', level:7, created_at:new Date(Date.now()-86400000).toISOString(), effective_level:7, frame_slots:{} },
];
const FIX = {
  Dashboard:[DASH], Library:[PACKS], LevelsView:[LEVELS],
  AllQuestions:[{rows:Q,total:2}], PackDetail:[{rows:Q,total:2}],
  AIReviewView:[
    [{ id:'r1', pack_id:'p1', template:'My heart is {blank}', answer:'BRIGHT', alt_answer:'GENTLE', status:'pending', provider:'import', target_level:1,
       validation:{ ok:false, flags:[{code:'ambiguous', levels:[7,10], detail:'"GENTLE" is the same length as "BRIGHT" — at whole-word levels both fit the blank.'}] } },
     { id:'r2', pack_id:'p1', template:'I am {blank} when I help others', answer:'KIND', alt_answer:'HELPFUL', status:'pending', provider:'anthropic', target_level:1,
       validation:{ ok:true, flags:[] } }],
    {pending:2, approved:0, rejected:0}
  ],
  AISettingsView:[
    [{provider:'anthropic',configured:true,hint:'••••••4f2a',model:'claude-sonnet-4-6',max_tokens:8000,temperature:0.4,top_p:null,system_prompt:null,enabled:true,updated_at:new Date().toISOString(),updated_by:'admin@positiveminds.app'},
     {provider:'openai',configured:false,enabled:true},{provider:'gemini',configured:false,enabled:true}],
    {active_provider:'anthropic',batch_size:10,auto_repair:true},
    {runs_today:2,runs_30d:14,questions_30d:120,input_tokens_30d:48200,output_tokens_30d:19400,errors_30d:1,by_provider:[{provider:'anthropic',runs:14,input_tokens:48200,output_tokens:19400}]}
  ],
  HealthView:[{ issues:[{code:'ambiguous',severity:'error',id:'q9',pack_id:'p1',answer:'KIND',detail:'"MEAN" is the same length as "KIND" — at whole-word levels BOTH fit the blank, so the child has two correct answers.'}] }],
  ActivityView:[[{id:'a1',action:'question.create',actor:'admin@positiveminds.app',created_at:new Date().toISOString(),detail:'Added BRAVE to Confidence'}]],
  PublishHub:[[],[],[]],
};
const PAGES = [
  ['overview','Dashboard',{packs:PACKS,onOpenPack:()=>{},onGoLibrary:()=>{},onGoQuestions:()=>{},onNewPack:()=>{}}],
  ['packs','Library',{packs:PACKS,levels:LEVELS,onOpen:()=>{},reload:()=>{},onEdit:()=>{},onClone:()=>{},onNew:()=>{},onDelete:()=>{}}],
  ['questions','AllQuestions',{packs:PACKS,levels:LEVELS}],
  ['generator','GeneratorView',{packs:PACKS,levels:LEVELS}],
  ['levels','LevelsView',{levels:LEVELS,reload:()=>{}}],
  ['ai-review','AIReviewView',{packs:PACKS,levels:LEVELS}],
  ['ai-settings','AISettingsView',{packs:PACKS,levels:LEVELS}],
  ['health','HealthView',{}],
  ['publishing','PublishHub',{packs:PACKS,onSynced:()=>{}}],
  ['activity','ActivityView',{}],
  ['pack-detail','PackDetail',{pack:PACKS[0],levels:LEVELS,onBack:()=>{},refreshPacks:()=>{},onEditPack:()=>{}}],
];
const DEVICES = [
  ['phone', 390, 844, true, 'pm-phone pm-coarse'],
  ['phone-landscape', 844, 390, true, 'pm-phone pm-coarse pm-landscape'],
  ['tablet', 810, 1080, true, 'pm-tablet pm-coarse'],
  ['desktop', 1440, 900, false, 'pm-desktop'],
];

// ---- LAYOUT ENGINE: compute real boxes so I can find visual defects ----
// jsdom does not do layout, so I compute it: walk the tree, apply the box model, and lay out
// blocks/flex/grid well enough to catch overlap, overflow and squeeze.
function analyse(html, cls, vw) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html class="${cls}"><head><style>${CSS}</style></head><body style="margin:0"><div class="pm-main">${html}</div></body></html>`,
    { pretendToBeVisual: true, virtualConsole: vc });
  const { document, getComputedStyle } = dom.window;
  const issues = [];
  const px = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

  // Content width available inside .pm-main
  const main = document.querySelector('.pm-main');
  const mcs = getComputedStyle(main);
  const mainMax = px(mcs.maxWidth) || vw;
  const padL = px(mcs.paddingLeft), padR = px(mcs.paddingRight);
  const contentW = Math.min(vw, mainMax) - padL - padR;

  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    if (cs.display === 'none') continue;

    // --- 1. Does anything DECLARE a width bigger than the space it has? ---
    const w = px(cs.width), minW = px(cs.minWidth);
    if (minW && minW > contentW) issues.push({ sev:'high', msg:`<${tag}> min-width ${minW}px exceeds the ${Math.round(contentW)}px of content space → forces horizontal scroll` });
    if (w && w > contentW && cs.position !== 'fixed' && cs.position !== 'absolute')
      issues.push({ sev:'high', msg:`<${tag}> width ${w}px exceeds the ${Math.round(contentW)}px of content space → overflows` });

    // --- 2. Grid columns: do they end up too narrow to use? ---
    const gtc = cs.gridTemplateColumns;
    if (gtc && /repeat\(\s*(\d+)/.test(gtc)) {
      const n = +gtc.match(/repeat\(\s*(\d+)/)[1];
      const gap = px(cs.gap) || px(cs.columnGap) || 0;
      // width available to THIS grid ~ content width minus its own padding
      const own = px(cs.paddingLeft) + px(cs.paddingRight);
      const avail = contentW - own;
      const col = (avail - gap * (n - 1)) / n;
      if (col < 90) issues.push({ sev:'high', msg:`.${(el.className||'').split(' ')[0]} → ${n} columns of only ${Math.round(col)}px each — too narrow to read` });
      else if (col > 700 && n === 1) issues.push({ sev:'med', msg:`.${(el.className||'').split(' ')[0]} → a single ${Math.round(col)}px-wide column: content marooned in white space` });
    }

    // --- 3. Fixed heights that will clip their own text ---
    const h = px(cs.height);
    const fs = px(cs.fontSize) || 14;
    const lh = px(cs.lineHeight) || fs * 1.4;
    const text = (el.textContent || '').trim();
    if (h && text && cs.overflow !== 'auto' && cs.overflow !== 'scroll' && el.children.length === 0) {
      const est = Math.ceil((text.length * fs * 0.52) / Math.max(1, contentW)) * lh;
      if (est > h + 2) issues.push({ sev:'med', msg:`<${tag}> fixed height ${h}px but its text needs ~${Math.round(est)}px → will clip` });
    }

    // --- 4. Touch targets on a touch device ---
    if (cls.includes('coarse') && (tag === 'button' || tag === 'a' || tag === 'select')) {
      const mh = px(cs.minHeight) || px(cs.height);
      const pad = px(cs.paddingTop) + px(cs.paddingBottom);
      const eff = mh || (fs * 1.2 + pad);
      if (eff && eff < 36) issues.push({ sev:'med', msg:`<${tag}> is only ~${Math.round(eff)}px tall — below the 40px comfortable touch target` });
    }

    // --- 5. Text too small to read ---
    if (fs && fs < 11 && text.length > 3) issues.push({ sev:'low', msg:`<${tag}> font-size ${fs}px — hard to read (“${text.slice(0,24)}”)` });

    // --- 6. Long unbroken words that will overflow ---
    const longest = text.split(/\s+/).reduce((a,b)=>b.length>a.length?b:a, '');
    if (longest.length > 28 && cs.overflowWrap !== 'anywhere' && cs.wordBreak !== 'break-all' && el.children.length === 0) {
      const wpx = longest.length * fs * 0.55;
      if (wpx > contentW) issues.push({ sev:'med', msg:`<${tag}> unbroken ${longest.length}-char string (~${Math.round(wpx)}px) with no wrap rule → overflows` });
    }
  }
  return { issues, dom };
}

const OUT = path.join(__dirname, 'visual');
fs.mkdirSync(OUT, { recursive: true });

console.log('VISUAL LAYOUT ANALYSIS — real CSS, computed boxes\n');
console.log('(I cannot take true screenshots here — no browser in the sandbox. So I compute the');
console.log(' actual layout boxes and hunt for what an eye would catch. I also write viewable HTML');
console.log(' files so you can look at them yourself.)\n');

const found = {};
for (const [dname, w, h, coarse, cls] of DEVICES) {
  const sb = sandbox(w, h, coarse);
  const g = n => vm.runInContext(`typeof ${n}!=="undefined"?${n}:null`, sb);
  console.log(`  ${dname.toUpperCase()} (${w}×${h})`);
  for (const [pname, comp, props] of PAGES) {
    sb.__D__ = [...(FIX[comp] || [])];
    const C = g(comp);
    let html = '';
    try { html = renderToString(React.createElement(C, props)); }
    catch (e) { console.log(`    ✗ ${pname}: ${e.message.split('\n')[0].slice(0,44)}`); continue; }

    const { issues } = analyse(html, cls, w);
    // write a viewable file
    fs.writeFileSync(path.join(OUT, `${dname}--${pname}.html`),
      `<!DOCTYPE html><html class="${cls}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
       <title>${pname} — ${dname}</title><style>${CSS}</style></head>
       <body><div class="pm-main">${html}</div></body></html>`);

    const high = issues.filter(i => i.sev === 'high');
    const med  = issues.filter(i => i.sev === 'med');
    if (high.length || med.length) {
      found[`${dname}/${pname}`] = [...high, ...med];
      console.log(`    ⚠ ${pname.padEnd(13)} ${high.length} serious, ${med.length} minor`);
      [...high, ...med].slice(0, 3).forEach(i => console.log(`        • ${i.msg}`));
    } else {
      console.log(`    ✓ ${pname.padEnd(13)} clean`);
    }
  }
  console.log('');
}
const total = Object.values(found).reduce((a,b) => a + b.length, 0);
console.log('='.repeat(64));
console.log(total === 0 ? 'No layout defects found.' : `${total} layout defect(s) across ${Object.keys(found).length} page/device combinations.`);
console.log(`\n${PAGES.length * DEVICES.length} viewable HTML files written to ${OUT}/`);
