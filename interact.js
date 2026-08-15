// INTERACTION TEST — actually click things. Nothing in my previous audits ever clicked a button.
const fs = require('fs'); const path = require('path'); const babel = require('@babel/core'); const vm = require('vm');
const { JSDOM } = require('jsdom');

const order = ['core.jsx','primitives.jsx','realtime.jsx','engine.jsx','firebase.jsx','editors.jsx','features.jsx','publish1.jsx','firebase2.jsx','publish2.jsx','devdocs.jsx','devnotes.jsx','levels.jsx','aireview.jsx','aisettings.jsx','generator.jsx','views1.jsx','views2.jsx','shell.jsx'];
const SRC_DIR = path.join(__dirname, 'src');
let src = '';
for (const f of order) {
  let c = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
  c = c.replace(/^import[^\n]*\n/gm, '').replace(/export default function App/, 'function App').replace(/^export\s+/gm, '');
  src += '\n' + c;
}
src = src.replace(/const useAsync = \(fn, deps = \[\]\) => \{[\s\S]*?\n\};/,
  `const useAsync=(fn,deps=[])=>{const [s]=useState({loading:false,error:null,data:(globalThis.__D__&&globalThis.__D__.length)?globalThis.__D__.shift():null});return {...s,reload:()=>{},setData:()=>{}};};`);
const compiled = babel.transformSync('const {useState,useEffect,useMemo,useCallback,useRef}=React;\n' + src,
  { presets: [['@babel/preset-react', { runtime: 'classic' }]] }).code;

const problems = [];
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
const { window } = dom;
global.window = window; global.document = window.document; global.navigator = window.navigator;
global.requestAnimationFrame = f => setTimeout(f, 0); global.cancelAnimationFrame = clearTimeout;
global.HTMLElement = window.HTMLElement; global.Element = window.Element; global.Node = window.Node;
global.getComputedStyle = window.getComputedStyle;
global.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = q => ({ matches: false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
window.scrollTo = () => {};
if (!window.crypto) window.crypto = {};
window.crypto.randomUUID = () => 'x' + Math.random().toString(36).slice(2);
global.crypto = window.crypto;
window.WebSocket = function () { this.close = () => {}; this.send = () => {}; };
global.WebSocket = window.WebSocket;
global.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('[]'), json: () => Promise.resolve([]), headers: { get: () => null } });
window.fetch = global.fetch;

const realErr = console.error;
console.error = (...a) => { const m = a.map(String).join(' '); if (!/act\(/.test(m)) problems.push(m.slice(0, 150)); };
console.warn = (...a) => { const m = a.map(String).join(' '); if (!/act\(/.test(m)) problems.push(m.slice(0, 150)); };

const React = require('react');
const ReactDOMClient = require('react-dom/client');
const { act } = require('react');

const sb = { React, ReactDOM: ReactDOMClient, window, document: window.document, navigator: window.navigator,
  fetch: global.fetch, console: { log(){}, warn: console.warn, error: console.error },
  setTimeout, clearTimeout, setInterval, clearInterval, localStorage: window.localStorage,
  WebSocket: window.WebSocket, crypto: window.crypto,
  requestAnimationFrame: global.requestAnimationFrame, cancelAnimationFrame: global.cancelAnimationFrame,
  getComputedStyle: window.getComputedStyle, URL, URLSearchParams,
  btoa: s => Buffer.from(s).toString('base64'), atob: s => Buffer.from(s, 'base64').toString() };
sb.globalThis = sb; sb.global = sb;
vm.createContext(sb);
vm.runInContext(compiled, sb);
const g = n => vm.runInContext(`typeof ${n}!=="undefined"?${n}:null`, sb);

const LEVELS = [
  { level:1, name:'First Words', tagline:'One letter', color:'#00B894', hidden_mode:'letters', letters_hidden_default:1, letter_position:'middle', letter_grouping:'grouped', theme:'T', age_hint:'5', letters_rule:'r', word_rule:'w' },
  { level:7, name:'Thoughtful', tagline:'Whole word', color:'#E17055', hidden_mode:'word', letters_hidden_default:9, theme:'T2', age_hint:'10', letters_rule:'r', word_rule:'w' },
];
const PACKS = [{ id:'p1', name:'Confidence', emoji:'💪', slug:'confidence', level:1, status:'published', active_questions:11, total_questions:11, color:'#00B894', tags:['core'], description:'d' }];
const Q = [{ id:'q1', pack_id:'p1', template:'I am {blank} today', answer:'BRAVE', alt_answer:'BOLD', status:'active', level:1, created_at:new Date().toISOString(), effective_level:1, frame_slots:{} }];
const DASH = { total_packs:15, published_packs:14, draft_packs:1, empty_packs:13, total_questions:12, active_questions:12, questions_by_level:{'1':11}, distinct_levels_used:2, avg_questions_per_pack:6.0 };
const F = { Dashboard:[DASH], Library:[PACKS], LevelsView:[LEVELS], AllQuestions:[{rows:Q,total:1}], PackDetail:[{rows:Q,total:1}],
  AIReviewView:[[], {pending:0,approved:0,rejected:0}],
  AISettingsView:[[{provider:'anthropic',configured:false,enabled:true}], {active_provider:'anthropic',batch_size:10,auto_repair:true}, {runs_today:0,runs_30d:0,questions_30d:0,input_tokens_30d:0,output_tokens_30d:0,errors_30d:0,by_provider:[]}],
  HealthView:[{issues:[]}], ActivityView:[[]], PublishHub:[[],[],[]] };

const pages = [
  ['Overview','Dashboard',{packs:PACKS,onOpenPack:()=>{},onGoLibrary:()=>{},onGoQuestions:()=>{},onNewPack:()=>{}}],
  ['Packs','Library',{packs:PACKS,levels:LEVELS,onOpen:()=>{},reload:()=>{},onEdit:()=>{},onClone:()=>{},onNew:()=>{},onDelete:()=>{}}],
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

(async () => {
  const log = realErr;
  log('\nINTERACTION TEST — clicking every button, changing every input\n');
  let totalClicks = 0, totalChanges = 0, broke = 0;

  for (const [name, comp, props] of pages) {
    problems.length = 0;
    sb.__D__ = [...(F[comp] || [])];
    const C = g(comp);
    const host = window.document.createElement('div');
    window.document.body.appendChild(host);
    const root = ReactDOMClient.createRoot(host);

    let clicks = 0, changes = 0, err = null;
    try {
      await act(async () => { root.render(React.createElement(C, props)); });

      // Click EVERY button (except obviously destructive text)
      const buttons = [...host.querySelectorAll('button')];
      for (const b of buttons) {
        const label = (b.textContent || b.getAttribute('aria-label') || '').toLowerCase();
        if (/delete|remove|reject|clear|sign out|archive/.test(label)) continue;  // don't fire destructive ones
        try {
          await act(async () => { b.click(); await new Promise(r => setTimeout(r, 0)); });
          clicks++;
        } catch (e) { problems.push(`click "${label.slice(0,20)}" → ${e.message.slice(0,60)}`); }
      }

      // Change EVERY select and text input
      for (const s of [...host.querySelectorAll('select')]) {
        const opts = [...s.querySelectorAll('option')];
        if (opts.length < 2) continue;
        try {
          await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
            setter.call(s, opts[1].value);
            s.dispatchEvent(new window.Event('change', { bubbles: true }));
          });
          changes++;
        } catch (e) { problems.push(`select change → ${e.message.slice(0,60)}`); }
      }
      for (const i of [...host.querySelectorAll('input[type=text],input:not([type]),textarea')]) {
        try {
          await act(async () => {
            const proto = i.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(i, 'test input');
            i.dispatchEvent(new window.Event('input', { bubbles: true }));
          });
          changes++;
        } catch (e) { problems.push(`input change → ${e.message.slice(0,60)}`); }
      }
    } catch (e) { err = e.message.split('\n')[0]; }

    totalClicks += clicks; totalChanges += changes;
    const uniq = [...new Set(problems)];
    if (err) { broke++; log(`  ✗ ${name.padEnd(13)} THREW: ${err.slice(0,55)}`); }
    else if (uniq.length) { broke++; log(`  ⚠ ${name.padEnd(13)} ${clicks} clicks, ${changes} changes — ${uniq.length} problem(s)`); uniq.slice(0,3).forEach(p => log(`      • ${p}`)); }
    else log(`  ✓ ${name.padEnd(13)} ${clicks} clicks, ${changes} changes — clean`);

    try { await act(async () => { root.unmount(); }); } catch {}
    host.remove();
  }

  log(`\n  ${totalClicks} buttons clicked, ${totalChanges} inputs changed.`);
  log(`  ${broke === 0 ? 'Nothing broke.' : broke + ' page(s) had problems.'}`);
})();
