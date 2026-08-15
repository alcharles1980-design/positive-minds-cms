// MOUNT the app for real (client-side render into jsdom) and capture every React warning.
// SSR never shows these — but they are exactly the bugs that cause flicker and broken state.
const fs=require('fs');const path=require('path');const babel=require('@babel/core');const vm=require('vm');
const {JSDOM,VirtualConsole}=require('jsdom');

const order=['core.jsx','primitives.jsx','realtime.jsx','engine.jsx','firebase.jsx','editors.jsx','features.jsx','publish1.jsx','firebase2.jsx','publish2.jsx','devdocs.jsx','devnotes.jsx','levels.jsx','aireview.jsx','aisettings.jsx','generator.jsx','views1.jsx','views2.jsx','shell.jsx'];
const SRC_DIR=path.join(__dirname,'src');
let src='';for(const f of order){let c=fs.readFileSync(path.join(SRC_DIR,f),'utf8');c=c.replace(/^import[^\n]*\n/gm,'').replace(/export default function App/,'function App').replace(/^export\s+/gm,'');src+='\n'+c;}
src=src.replace(/const useAsync = \(fn, deps = \[\]\) => \{[\s\S]*?\n\};/,
 `const useAsync=(fn,deps=[])=>{const [s,set]=useState({loading:false,error:null,data:(globalThis.__D__&&globalThis.__D__.length)?globalThis.__D__.shift():null});return {...s,reload:()=>{},setData:()=>{}};};`);
const compiled=babel.transformSync('const {useState,useEffect,useMemo,useCallback,useRef}=React;\n'+src,{presets:[['@babel/preset-react',{runtime:'classic'}]]}).code;

const warnings=[];
const dom=new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>',{pretendToBeVisual:true,url:'http://localhost/'});
const {window}=dom;
global.window=window; global.document=window.document; global.navigator=window.navigator;
global.requestAnimationFrame=f=>setTimeout(f,0); global.cancelAnimationFrame=clearTimeout;
global.HTMLElement=window.HTMLElement; global.Element=window.Element; global.Node=window.Node;
global.getComputedStyle=window.getComputedStyle;
global.IS_REACT_ACT_ENVIRONMENT=true;
window.matchMedia=q=>({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
window.scrollTo=()=>{};
if(!window.crypto) window.crypto={};
window.crypto.randomUUID=()=>'x'+Math.random().toString(36).slice(2);
global.crypto=window.crypto;
window.WebSocket=function(){this.close=()=>{};this.send=()=>{};};
global.WebSocket=window.WebSocket;
global.fetch=()=>Promise.resolve({ok:true,status:200,text:()=>Promise.resolve('[]'),json:()=>Promise.resolve([]),headers:{get:()=>null}});
window.fetch=global.fetch;

// CAPTURE React's warnings
const realErr=console.error, realWarn=console.warn;
console.error=(...a)=>{warnings.push(['error',a.map(String).join(' ').slice(0,180)]);};
console.warn =(...a)=>{warnings.push(['warn', a.map(String).join(' ').slice(0,180)]);};

const React=require('react');
const ReactDOMClient=require('react-dom/client');
const {act}=require('react');

const sb={React,ReactDOM:ReactDOMClient,window,document:window.document,navigator:window.navigator,
 fetch:global.fetch,console:{log(){},warn:console.warn,error:console.error},
 setTimeout,clearTimeout,setInterval,clearInterval,localStorage:window.localStorage,
 WebSocket:window.WebSocket,crypto:window.crypto,
 requestAnimationFrame:global.requestAnimationFrame,cancelAnimationFrame:global.cancelAnimationFrame,
 getComputedStyle:window.getComputedStyle,URL,URLSearchParams,
 btoa:s=>Buffer.from(s).toString('base64'),atob:s=>Buffer.from(s,'base64').toString()};
sb.globalThis=sb; sb.global=sb;
vm.createContext(sb);
try{ vm.runInContext(compiled,sb); }
catch(e){ realErr('MODULE EVAL FAILED:',e.message); process.exit(1); }

const g=n=>vm.runInContext(`typeof ${n}!=="undefined"?${n}:null`,sb);

// Fixtures
const LEVELS=[{level:1,name:'First Words',tagline:'One letter',color:'#00B894',hidden_mode:'letters',letters_hidden_default:1,letter_position:'middle',letter_grouping:'grouped',theme:'T',age_hint:'5',letters_rule:'r',word_rule:'w'}];
const PACKS=[{id:'p1',name:'Confidence',emoji:'💪',slug:'confidence',level:1,status:'published',active_questions:11,total_questions:11,color:'#00B894',tags:['core'],description:'d'}];
const Q=[{id:'q1',pack_id:'p1',template:'I am {blank} today',answer:'BRAVE',alt_answer:'BOLD',status:'active',level:1,created_at:new Date().toISOString(),effective_level:1,frame_slots:{}}];
const DASH={total_packs:15,published_packs:14,draft_packs:1,empty_packs:13,total_questions:12,active_questions:12,questions_by_level:{'1':11},distinct_levels_used:2,avg_questions_per_pack:6.0};
const F={Dashboard:[DASH],Library:[PACKS],LevelsView:[LEVELS],AllQuestions:[{rows:Q,total:1}],PackDetail:[{rows:Q,total:1}],
 AIReviewView:[[],{pending:0,approved:0,rejected:0}],
 AISettingsView:[[{provider:'anthropic',configured:false,enabled:true}],{active_provider:'anthropic',batch_size:10,auto_repair:true},{runs_today:0,runs_30d:0,questions_30d:0,input_tokens_30d:0,output_tokens_30d:0,errors_30d:0,by_provider:[]}],
 HealthView:[{issues:[]}],ActivityView:[[]],PublishHub:[[],[],[]]};

const pages=[['Overview','Dashboard',{packs:PACKS}],['Packs','Library',{packs:PACKS,levels:LEVELS,onOpen:()=>{},reload:()=>{}}],
 ['Questions','AllQuestions',{packs:PACKS,levels:LEVELS}],['Generator','GeneratorView',{packs:PACKS,levels:LEVELS}],
 ['Levels','LevelsView',{levels:LEVELS,reload:()=>{}}],['AI Review','AIReviewView',{packs:PACKS,levels:LEVELS}],
 ['AI Settings','AISettingsView',{packs:PACKS,levels:LEVELS}],['Health','HealthView',{}],
 ['Publishing','PublishHub',{packs:PACKS,onSynced:()=>{}}],['Activity','ActivityView',{}],
 ['Developer','DeveloperNotes',{}],['Pack detail','PackDetail',{pack:PACKS[0],levels:LEVELS,onBack:()=>{},refreshPacks:()=>{},onEditPack:()=>{}}]];

(async()=>{
  console.log = realErr; // print through
  const results=[];
  for(const [name,comp,props] of pages){
    warnings.length=0;
    sb.__D__=[...(F[comp]||[])];
    const C=g(comp);
    const host=window.document.createElement('div');
    window.document.body.appendChild(host);
    const root=ReactDOMClient.createRoot(host);
    let threw=null;
    try{
      await act(async()=>{ root.render(React.createElement(C,props)); });
      await act(async()=>{ await new Promise(r=>setTimeout(r,10)); }); // let effects settle
    }catch(e){ threw=e.message.split('\n')[0]; }
    const w=[...new Set(warnings.map(x=>x[1]))].filter(x=>!/not wrapped in act|ReactDOMTestUtils/i.test(x));
    results.push([name,threw,w]);
    try{ await act(async()=>{ root.unmount(); }); }catch(e){}
    host.remove();
  }
  console.error=realErr; console.warn=realWarn;
  console.log('\nRUNTIME MOUNT — React warnings & errors that SSR never shows\n');
  let bad=0;
  for(const [name,threw,w] of results){
    if(threw){ bad++; console.log(`  ✗ ${name.padEnd(13)} THREW: ${threw.slice(0,60)}`); }
    else if(w.length){ bad++; console.log(`  ⚠ ${name.padEnd(13)} ${w.length} warning(s)`); w.slice(0,3).forEach(x=>console.log(`      • ${x}`)); }
    else console.log(`  ✓ ${name.padEnd(13)} clean`);
  }
  console.log(`\n  ${bad===0?'No runtime warnings or errors.':bad+' page(s) with problems'}`);
})();
