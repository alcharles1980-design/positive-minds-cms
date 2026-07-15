// split.cjs — pm_cms.jsx  ->  src/*.jsx  (the 20 module sources)
// The combined file carries "// ===== name.jsx =====" banners marking each module's origin.
// Everything before the first banner is the prelude (React globals the assembler prepends);
// the trailing ReactDOM mount is the epilogue. Split is exactly reversible — assemble.cjs
// reproduces pm_cms.jsx byte-for-byte, and verify.cjs asserts it.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync('pm_cms.jsx', 'utf8');
const lines = src.split('\n');

const RE = /^\/\/ ===== (.+\.jsx) =====$/;
const marks = [];
lines.forEach((l, i) => { const m = l.match(RE); if (m) marks.push({ name: m[1], line: i }); });

// Epilogue = the ReactDOM mount that the builder appends after the last module.
const mountIdx = lines.findIndex(l => /^const root = ReactDOM\.createRoot/.test(l));
if (mountIdx < 0) throw new Error('mount line not found');

const prelude = lines.slice(0, marks[0].line).join('\n');
const epilogue = lines.slice(mountIdx).join('\n');

fs.mkdirSync('src', { recursive: true });
const order = [];
marks.forEach((m, k) => {
  const from = m.line + 1;                                   // line AFTER the banner
  const to = (k + 1 < marks.length) ? marks[k + 1].line : mountIdx;
  const body = lines.slice(from, to).join('\n');
  fs.writeFileSync(path.join('src', m.name), body);
  order.push(m.name);
});

fs.writeFileSync('.build/prelude.js', prelude);
fs.writeFileSync('.build/epilogue.js', epilogue);
fs.writeFileSync('.build/order.json', JSON.stringify(order, null, 2));

console.log(`split ${order.length} modules:`);
order.forEach(n => {
  const sz = fs.readFileSync(path.join('src', n), 'utf8').split('\n').length;
  console.log(`  ${n.padEnd(18)} ${String(sz).padStart(5)} lines`);
});
