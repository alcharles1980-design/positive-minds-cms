// READ the pages the way a human would see them — the actual words, in order, with structure.
// This is the closest I can get to "looking at it": I read what it says.
const React=require('react');const {renderToString}=require('react-dom/server');const fs=require('fs');const path=require('path');
const babel=require('@babel/core');const vm=require('vm');const {JSDOM,VirtualConsole}=require('jsdom');
const vc=new VirtualConsole();
const order=['core.jsx','primitives.jsx','realtime.jsx','engine.jsx','firebase.jsx','editors.jsx','features.jsx','publish1.jsx','firebase2.jsx','publish2.jsx','devdocs.jsx','devnotes.jsx','levels.jsx','aireview.jsx','aisettings.jsx','generator.jsx','views1.jsx','views2.jsx','shell.jsx'];
const SRC_DIR=path.join(__dirname,'src');
let src='';for(const f of order){let c=fs.readFileSync(path.join(SRC_DIR,f),'utf8');c=c.replace(/^import[^\n]*\n/gm,'').replace(/export default function App/,'function App').replace(/^export\s+/gm,'');src+='\n'+c;}
src=src.replace(/const useAsync = \(fn, deps = \[\]\) => \{[\s\S]*?\n\};/,`const useAsync=(fn,deps=[])=>({loading:false,error:null,data:(globalThis.__D__&&globalThis.__D__.length)?globalThis.__D__.shift():null,reload:()=>{},setData:()=>{}});`);
const compiled=babel.transformSync('const {useState,useEffect,useMemo,useCallback,useRef}=React;\n'+src,{presets:[['@babel/preset-react',{runtime:'classic'}]]}).code;
const el=()=>({style:{},setAttribute(){},getAttribute:()=>null,appendChild(){},classList:{add(){},remove(){},toggle(){}},addEventListener(){},removeEventListener(){},focus(){},select(){}});
const doc={documentElement:el(),addEventListener(){},removeEventListener(){},createElement:el,head:el(),body:el(),getElementById:()=>null,querySelector:()=>null,title:''};
const win={innerWidth:1440,innerHeight:900,matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),addEventListener(){},removeEventListener(){},localStorage:{getItem:()=>null,setItem(){},removeItem(){}},location:{href:'',hash:'',search:''},history:{replaceState(){}},navigator:{onLine:true,clipboard:{writeText:()=>Promise.resolve()}},WebSocket:function(){this.close=()=>{}},requestAnimationFrame:f=>{f();return 1},cancelAnimationFrame(){}};win.window=win;
const sb={React,window:win,document:doc,fetch:()=>Promise.resolve({ok:true,status:200,text:()=>Promise.resolve('[]')}),console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,setInterval:()=>0,clearInterval,navigator:win.navigator,localStorage:win.localStorage,WebSocket:win.WebSocket,crypto:{randomUUID:()=>'u'},requestAnimationFrame:win.requestAnimationFrame,cancelAnimationFrame:win.cancelAnimationFrame};
sb.globalThis=sb;vm.createContext(sb);vm.runInContext(compiled,sb);
const g=n=>vm.runInContext(`typeof ${n}!=="undefined"?${n}:null`,sb);
const DASH={total_packs:15,published_packs:14,draft_packs:1,empty_packs:13,total_questions:12,active_questions:12,questions_by_level:{'1':11,'10':1},distinct_levels_used:2,avg_questions_per_pack:6.0};
const LEVELS=[{level:1,name:'First Words',tagline:'Just one letter to find',color:'#00B894',hidden_mode:'letters',letters_hidden_default:1,letter_position:'middle',letter_grouping:'grouped',theme:'Simple self-affirmation',age_hint:'Around 5',letters_rule:'One letter',word_rule:'Short words'}];
const PACKS=[{id:'p1',name:'Confidence',emoji:'💪',slug:'confidence',level:1,status:'published',active_questions:11,total_questions:11,color:'#00B894',tags:['core'],description:'Believing in yourself',content_version:57,released_version:56}];
const Q=[{id:'q1',pack_id:'p1',template:'I am {blank} when I try new things',answer:'BRAVE',alt_answer:'BOLD',status:'active',level:1,created_at:new Date().toISOString(),effective_level:1,frame_slots:{}}];
const FIX={Dashboard:[DASH],Library:[PACKS],LevelsView:[LEVELS],AllQuestions:[{rows:Q,total:1}],PackDetail:[{rows:Q,total:1}],
 AIReviewView:[[{id:'r1',pack_id:'p1',template:'My heart is {blank}',answer:'BRIGHT',alt_answer:'GENTLE',status:'pending',provider:'import',target_level:1,validation:{ok:false,flags:[{code:'ambiguous',levels:[7,10],detail:'"GENTLE" is the same length as "BRIGHT" — at whole-word levels both fit the blank.'}]}}],{pending:1,approved:0,rejected:0}],
 AISettingsView:[[{provider:'anthropic',configured:true,hint:'••••••4f2a',model:'claude-sonnet-4-6',max_tokens:8000,temperature:0.4,enabled:true,updated_at:new Date().toISOString(),updated_by:'admin@positiveminds.app'},{provider:'openai',configured:false,enabled:true},{provider:'gemini',configured:false,enabled:true}],{active_provider:'anthropic',batch_size:10,auto_repair:true},{runs_today:2,runs_30d:14,questions_30d:120,input_tokens_30d:48200,output_tokens_30d:19400,errors_30d:1,by_provider:[{provider:'anthropic',runs:14,input_tokens:48200,output_tokens:19400}]}],
 HealthView:[{summary:{ambiguous:1,same_word:0,missing_alt:0,duplicates:0,reused_word:0,thin_packs:1,invalid_template:0,multi_blank:0,bad_chars:0},details:[{code:'ambiguous',severity:'error',id:'q9',pack_id:'p1',answer:'KIND',detail:'"MEAN" is the same length as "KIND" — at whole-word levels BOTH fit the blank, so the child has two correct answers.'}]}],
 ActivityView:[[]],PublishHub:[[],[],[]]};
const want=process.argv[2];
const PAGES=[['Overview','Dashboard',{packs:PACKS,onOpenPack:()=>{},onGoLibrary:()=>{},onGoQuestions:()=>{},onNewPack:()=>{}}],
 ['AI Review','AIReviewView',{packs:PACKS,levels:LEVELS}],['Health','HealthView',{}],
 ['AI Settings','AISettingsView',{packs:PACKS,levels:LEVELS}]];
for(const [name,comp,props] of PAGES){
  if(want && name.toLowerCase()!==want.toLowerCase()) continue;
  sb.__D__=[...(FIX[comp]||[])];
  const html=renderToString(React.createElement(g(comp),props));
  const d=new JSDOM(`<body>${html}</body>`,{virtualConsole:vc}).window.document;
  console.log('\n' + '═'.repeat(70));
  console.log('  ' + name.toUpperCase());
  console.log('═'.repeat(70));
  const walk=(node,depth=0)=>{
    for(const c of node.childNodes){
      if(c.nodeType===3){ const t=(c.textContent||'').trim(); if(t) process.stdout.write(t+' '); continue; }
      if(c.nodeType!==1) continue;
      const tag=c.tagName.toLowerCase();
      if(/^h[1-6]$/.test(tag)){ console.log('\n\n' + '  '.repeat(depth) + '### ' + (c.textContent||'').trim()); continue; }
      if(tag==='button'){ process.stdout.write(`\n${'  '.repeat(depth)}[ ${(c.textContent||c.getAttribute('aria-label')||'?').trim()} ] `); continue; }
      if(tag==='select'){ const o=[...c.querySelectorAll('option')].map(x=>x.textContent).slice(0,3); process.stdout.write(`\n${'  '.repeat(depth)}( ${c.getAttribute('aria-label')||'select'}: ${o.join(' / ')}… ) `); continue; }
      if(tag==='input'||tag==='textarea'){ process.stdout.write(`\n${'  '.repeat(depth)}[__ ${c.getAttribute('aria-label')||c.getAttribute('placeholder')||'field'} __] `); continue; }
      if(tag==='p'||tag==='div'){ const own=[...c.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join(' ').trim();
        if(own && c.children.length===0){ console.log('\n'+'  '.repeat(depth)+own); continue; } }
      walk(c,depth+1);
    }
  };
  walk(d.body);
  console.log('\n');
}
