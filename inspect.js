// Render each page into a REAL DOM with the REAL stylesheet, then inspect computed styles.
// This is what I should have been doing: looking at the result, not the source.
const React = require('react');
const { renderToString } = require('react-dom/server');
const fs = require('fs');
const path = require('path');
const babel = require('@babel/core');
const vm = require('vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const vc = new VirtualConsole(); // swallow jsdom's own warnings

// ---- build the app, with useAsync stubbed so pages render LOADED ----
const order = ['core.jsx','primitives.jsx','realtime.jsx','engine.jsx','firebase.jsx','editors.jsx','features.jsx','publish1.jsx','firebase2.jsx','publish2.jsx','devdocs.jsx','devnotes.jsx','levels.jsx','aireview.jsx','aisettings.jsx','generator.jsx','views1.jsx','views2.jsx','shell.jsx'];
const SRC_DIR = path.join(__dirname, 'src');
let src = '';
for (const f of order) {
  let c = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
  c = c.replace(/^import[^\n]*\n/gm, '').replace(/export default function App/, 'function App').replace(/^export\s+/gm, '');
  src += '\n' + c;
}
src = src.replace(/const useAsync = \(fn, deps = \[\]\) => \{[\s\S]*?\n\};/,
  `const useAsync=(fn,deps=[])=>{let d=null;try{d=globalThis.__D__&&globalThis.__D__.length?globalThis.__D__.shift():null;}catch(e){}return{loading:false,error:null,data:d,reload:()=>{},setData:()=>{}};};`);

const compiled = babel.transformSync('const {useState,useEffect,useMemo,useCallback,useRef}=React;\n' + src,
  { presets: [['@babel/preset-react', { runtime: 'classic' }]] }).code;

// ---- get the REAL stylesheet by RENDERING GlobalStyle ----
// (Regexing the source leaves ${themeVars(...)} template placeholders unevaluated, which jsdom
//  rejects — so the whole stylesheet was silently dropped and every computed style was a lie.)
let CSS = '';
{
  const boot = sandbox(1440, 900, false);
  const GS = vm.runInContext('typeof GlobalStyle!=="undefined"?GlobalStyle:null', boot);
  if (!GS) { console.error('GlobalStyle not found — aborting.'); process.exit(1); }
  const styleHtml = renderToString(React.createElement(GS));
  const m = styleHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/);
  CSS = m ? m[1] : '';
}
if (!CSS || CSS.includes('${')) {
  console.error('CSS still contains unevaluated template placeholders — the inspector would be meaningless. Aborting.');
  process.exit(1);
}
console.log(`Rendered ${CSS.length} chars of REAL evaluated CSS\n`);

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

// ---- realistic fixtures (shapes taken from the live DB) ----
const DASH = { total_packs:15, published_packs:14, draft_packs:1, empty_packs:13, total_questions:12, active_questions:12, questions_by_level:{'1':11,'10':1}, distinct_levels_used:2, avg_questions_per_pack:6.0 };
const LEVELS = [
  { level:1, name:'First Words', tagline:'Just one letter to find', color:'#00B894', hidden_mode:'letters', letters_hidden_default:1, letter_position:'middle', letter_grouping:'grouped', theme:'Simple self-affirmation', age_hint:'Around 5', letters_rule:'One letter hidden', word_rule:'Short, simple words' },
  { level:7, name:'Thoughtful', tagline:'The whole word', color:'#E17055', hidden_mode:'word', letters_hidden_default:9, theme:'Nuanced', age_hint:'Around 10', letters_rule:'Whole word', word_rule:'Longer words' },
];
const PACKS = [
  { id:'p1', name:'Confidence', emoji:'💪', slug:'confidence', level:1, status:'published', active_questions:11, total_questions:11, color:'#00B894', tags:['core','starter'], description:'Believing in yourself', content_version:56, released_version:56 },
  { id:'p2', name:'Calmness', emoji:'🌊', slug:'calmness', level:1, status:'published', active_questions:0, total_questions:0, color:'#0984E3', tags:[], description:'Staying steady', content_version:1, released_version:1 },
];
const Q = [{ id:'q1', pack_id:'p1', template:'I am {blank} when I try new things', answer:'BRAVE', alt_answer:'BOLD', status:'active', level:1, created_at:new Date().toISOString(), effective_level:1, letter_position:'middle', letter_grouping:'grouped', frame_slots:{} }];

const FIX = {
  Dashboard:[DASH], Library:[PACKS], LevelsView:[LEVELS],
  AllQuestions:[{rows:Q,total:1}], PackDetail:[{rows:Q,total:1}],
  AIReviewView:[[], {pending:0,approved:0,rejected:0}],
  AISettingsView:[[{provider:'anthropic',configured:false,enabled:true},{provider:'openai',configured:false,enabled:true},{provider:'gemini',configured:false,enabled:true}], {active_provider:'anthropic',batch_size:10,auto_repair:true}, {runs_today:0,runs_30d:0,questions_30d:0,input_tokens_30d:0,output_tokens_30d:0,errors_30d:0,by_provider:[]}],
  HealthView:[{issues:[]}], ActivityView:[[]], PublishHub:[[],[],[]],
};

const PAGES = [
  ['Overview','Dashboard',{packs:PACKS}],
  ['Packs','Library',{packs:PACKS,levels:LEVELS,onOpen:()=>{},reload:()=>{}}],
  ['Questions','AllQuestions',{packs:PACKS,levels:LEVELS}],
  ['Generator','GeneratorView',{packs:PACKS,levels:LEVELS}],
  ['Levels','LevelsView',{levels:LEVELS,reload:()=>{}}],
  ['AI Review','AIReviewView',{packs:PACKS,levels:LEVELS}],
  ['AI Settings','AISettingsView',{packs:PACKS,levels:LEVELS}],
  ['Health','HealthView',{}],
  ['Publishing','PublishHub',{packs:PACKS,onSynced:()=>{}}],
  ['Activity','ActivityView',{}],
  ['Pack detail','PackDetail',{pack:PACKS[0],levels:LEVELS,onBack:()=>{},refreshPacks:()=>{},onEditPack:()=>{}}],
];

const DEVICES = [
  ['phone portrait', 390, 844, true, 'pm-phone'],
  ['phone landscape', 844, 390, true, 'pm-phone pm-landscape'],
  ['tablet', 810, 1080, true, 'pm-tablet'],
  ['desktop', 1440, 900, false, 'pm-desktop'],
];

// ---- INSPECT: walk the real DOM and find genuine defects ----
function inspect(html, deviceClass, viewportW) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html class="${deviceClass}${deviceClass.includes('phone')||deviceClass.includes('tablet')?' pm-coarse':''}">
     <head><style>${CSS}</style></head>
     <body><div class="pm-main">${html}</div></body></html>`,
    { pretendToBeVisual: true, virtualConsole: vc }
  );
  const { document, getComputedStyle } = dom.window;
  const issues = [];
  const all = document.querySelectorAll('*');

  for (const el of all) {
    const cs = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();
    const inline = el.getAttribute('style') || '';

    // 1. Fixed width that exceeds the viewport → horizontal overflow
    const wMatch = inline.match(/(?:^|;)\s*width:\s*(\d+)px/);
    if (wMatch) {
      const w = +wMatch[1];
      if (w > viewportW - 32) issues.push(`<${tag}> fixed width ${w}px > usable ${viewportW-32}px → OVERFLOWS`);
    }
    // 2. minWidth that can't fit
    const mwMatch = inline.match(/min-width:\s*(\d+)px/);
    if (mwMatch) {
      const mw = +mwMatch[1];
      if (mw > viewportW - 32) issues.push(`<${tag}> min-width ${mw}px > usable ${viewportW-32}px → OVERFLOWS`);
    }
    // 3. Text that is invisible (same colour as its background)
    const col = (cs.color||'').replace(/\s/g,'');
    const bg = (cs.backgroundColor||'').replace(/\s/g,'');
    if (col && bg && col === bg && (el.textContent||'').trim()) {
      issues.push(`<${tag}> text colour === background (${col}) → INVISIBLE TEXT`);
    }
    // 4. Font size below legibility
    const fs = parseFloat(cs.fontSize);
    if (fs && fs < 10 && (el.textContent||'').trim().length > 2) {
      issues.push(`<${tag}> font-size ${fs}px → too small to read`);
    }
    // 5. A button with no accessible label
    if (tag === 'button' && !(el.textContent||'').trim() && !el.getAttribute('aria-label') && !el.getAttribute('title')) {
      issues.push(`<button> has no text, aria-label or title → UNLABELLED`);
    }
    // 6. An input with no label/aria/placeholder
    if ((tag === 'input' || tag === 'select' || tag === 'textarea')) {
      // A control WRAPPED IN A <label> is programmatically associated (implicit association) — that
      // is valid HTML and screen readers announce it. Checking only for aria-label/for= produced
      // false positives on every field built with our <Field> primitive.
      const implicit = el.labels && el.labels.length > 0;
      const hasLabel = implicit || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title');
      if (!hasLabel && el.getAttribute('type') !== 'checkbox') {
        issues.push(`<${tag}> has NO label of any kind → UNLABELLED FIELD`);
      }
    }
  }
  return { issues: [...new Set(issues)], count: all.length };
}

console.log('REAL DOM INSPECTION — every page, every device\n');
const findings = {};
for (const [dname, w, h, coarse, cls] of DEVICES) {
  const sb = sandbox(w, h, coarse);
  const g = n => vm.runInContext(`typeof ${n}!=="undefined"?${n}:null`, sb);
  console.log(`  ${dname.toUpperCase()} (${w}×${h})`);
  for (const [pname, comp, props] of PAGES) {
    const C = g(comp);
    if (!C) { console.log(`    ✗ ${pname}: component missing`); continue; }
    sb.__D__ = [...(FIX[comp] || [])];
    let html = '';
    try { html = renderToString(React.createElement(C, props)); }
    catch (e) { console.log(`    ✗ ${pname}: THREW ${e.message.split('\n')[0].slice(0,40)}`); continue; }
    const { issues, count } = inspect(html, cls, w);
    if (issues.length) {
      console.log(`    ⚠ ${pname.padEnd(12)} ${count} els — ${issues.length} issue(s)`);
      for (const i of issues.slice(0, 4)) console.log(`        • ${i}`);
      findings[`${dname} / ${pname}`] = issues;
    } else {
      console.log(`    ✓ ${pname.padEnd(12)} ${count} els`);
    }
  }
  console.log('');
}

const total = Object.values(findings).reduce((a, b) => a + b.length, 0);
console.log(`\n${'='.repeat(60)}\n${total === 0 ? 'No defects found.' : total + ' defect(s) across ' + Object.keys(findings).length + ' page/device combinations.'}`);
