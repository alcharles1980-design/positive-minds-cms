// THE ENGINE — the heart of the system. Four copies must be byte-identical, and the masking must
// never produce a broken puzzle. Stress it far harder than the happy path.
const fs=require('fs'),vm=require('vm');
function grab(file, isTS){
  const s=fs.readFileSync(file,'utf8');
  const strip=x=>x.replace(/:\s*number\[\]/g,'').replace(/:\s*any\[\]/g,'').replace(/:\s*string\[\]/g,'')
    .replace(/reusedIn: any/g,'reusedIn').replace(/:\s*string/g,'').replace(/:\s*number/g,'')
    .replace(/:\s*boolean/g,'').replace(/:\s*any/g,'').replace(/new Set<number>\(\)/g,'new Set()')
    .replace(/\(l: any\)/g,'(l)').replace(/\(c: any\)/g,'(c)');
  const mw = isTS ? s.match(/function maskWord\(word[\s\S]*?\n\}/)[0] : s.match(/const maskWord = \(word[\s\S]*?\n\};/)[0];
  const sb={}; vm.createContext(sb); vm.runInContext(isTS?strip(mw):mw, sb);
  return vm.runInContext('maskWord',sb);
}
const impls = {
  'client (core.jsx)':        grab('v2/core.jsx', false),
  'content-api':              grab('content-api/index.ts', true),
  'generate-questions':       grab('generate-questions/index.ts', true),
};

console.log('1. PARITY — all copies of maskWord must agree, byte for byte\n');
const words=['A','AB','ABC','BRAVE','STRONG','MAGNIFICENT','EXTRAORDINARILY','SELF-ASSURED',"DON'T",'ÉLAN','😀SMILE'];
const positions=['start','middle','end','random','bogus'];
const groupings=['grouped','spread','bogus'];
let cases=0, mismatch=0;
const names=Object.keys(impls);
for(const w of words) for(let L=-1;L<=w.length+2;L++) for(const p of positions) for(const gr of groupings){
  cases++;
  const results = names.map(n=>{ try{ return impls[n](w,L,p,gr); }catch(e){ return 'THREW:'+e.message; } });
  if(new Set(results).size !== 1){
    mismatch++;
    if(mismatch<=3) console.log(`  MISMATCH "${w}" L=${L} ${p}/${gr}:`, names.map((n,i)=>`${n}=${results[i]}`).join(' | '));
  }
}
console.log(`  ${cases} cases across ${names.length} implementations — ${mismatch===0?'✓ ALL IDENTICAL':'✗ '+mismatch+' MISMATCHES'}\n`);

console.log('2. INVARIANTS — properties the masking must ALWAYS hold\n');
const mask = impls['client (core.jsx)'];
const violations=[];
for(const w of ['BRAVE','STRONG','KIND','MAGNIFICENT','JOY','A','AB']){
  for(let L=0;L<=w.length+1;L++) for(const p of positions.slice(0,4)) for(const gr of groupings.slice(0,2)){
    const out = mask(w,L,p,gr);
    // (a) output length must equal input length (or be the all-blank form)
    if(out.length !== w.length && !/^_+$/.test(out))
      violations.push(`length changed: "${w}" L=${L} → "${out}"`);
    // (b) every non-underscore char must match the original at that index
    if(out.length === w.length)
      for(let i=0;i<out.length;i++)
        if(out[i] !== '_' && out[i] !== w.toUpperCase()[i])
          violations.push(`corrupted char: "${w}" L=${L} ${p}/${gr} → "${out}" (index ${i})`);
    // (c) the count of underscores should equal min(L, len) — unless whole-word
    const us=(out.match(/_/g)||[]).length;
    const expect=Math.max(0,Math.min(L,w.length));
    if(!/^_+$/.test(out) && us!==expect)
      violations.push(`wrong blank count: "${w}" L=${L} ${p}/${gr} → "${out}" (${us} blanks, expected ${expect})`);
    // (d) DETERMINISM — same input must give same output
    if(mask(w,L,p,gr)!==out) violations.push(`NOT DETERMINISTIC: "${w}" L=${L}`);
  }
}
const uniq=[...new Set(violations)];
console.log(`  ${uniq.length===0 ? '✓ all invariants hold (length preserved, chars uncorrupted, blank count correct, deterministic)' : '✗ '+uniq.length+' violation(s)'}`);
uniq.slice(0,6).forEach(v=>console.log(`     • ${v}`));

console.log('\n3. THE PUZZLE-BREAKING CHECK — can a child ever face two correct answers?\n');
// Recreate the ambiguity rule and hunt for real breaks in plausible content
const altFits=(blank,alt)=>{ alt=(alt||'').toUpperCase(); if(alt.length!==blank.length) return false;
  for(let i=0;i<blank.length;i++) if(blank[i]!=='_'&&blank[i]!==alt[i]) return false; return true; };
const LEVELS=[{level:1,hidden_mode:'letters',letters_hidden_default:1,letter_position:'middle',letter_grouping:'grouped'},
 {level:4,hidden_mode:'letters',letters_hidden_default:3,letter_position:'middle',letter_grouping:'grouped'},
 {level:6,hidden_mode:'letters',letters_hidden_default:4,letter_position:'middle',letter_grouping:'spread'},
 {level:7,hidden_mode:'word'},{level:10,hidden_mode:'word'}];
const pairs=[['BRAVE','BOLD'],['PROUD','CALM'],['BRIGHT','GENTLE'],['SURE','GLAD'],['KIND','MEAN'],
 ['STRONG','HAPPY'],['CHEERFUL','GRATEFUL'],['BRAVE','BRAVO'],['CARING','DARING'],['HELPFUL','NICE']];
for(const [a,b] of pairs){
  const bad=[];
  for(const l of LEVELS){
    const blank = l.hidden_mode==='word' ? '_'.repeat(Math.max(3,a.length))
      : mask(a, Math.min(l.letters_hidden_default, Math.max(1,a.length-1)), l.letter_position, l.letter_grouping);
    if(altFits(blank,b)) bad.push(l.level);
  }
  console.log(`  ${bad.length?'✗':'✓'} ${a}(${a.length})/${b}(${b.length})  ${bad.length?'AMBIGUOUS at L'+bad.join(',L'):'safe at every level'}`);
}
