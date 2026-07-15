// assemble.cjs — src/*.jsx  ->  pm_cms.jsx
// Concatenates the modules in fixed dependency order, re-emitting the "// ===== name.jsx ====="
// banners, wrapped by the prelude (React globals) and epilogue (ReactDOM mount).
// MUST be byte-reversible with split.cjs. verify.cjs asserts this.
const fs = require('fs');
const path = require('path');

const order    = JSON.parse(fs.readFileSync('.build/order.json', 'utf8'));
const prelude  = fs.readFileSync('.build/prelude.js', 'utf8');
const epilogue = fs.readFileSync('.build/epilogue.js', 'utf8');

const parts = [prelude];
for (const name of order) {
  parts.push(`// ===== ${name} =====`);
  parts.push(fs.readFileSync(path.join('src', name), 'utf8'));
}
const out = parts.join('\n') + '\n' + epilogue;
fs.writeFileSync('pm_cms.jsx', out);
console.log(`assembled pm_cms.jsx — ${order.length} modules, ${out.split('\n').length} lines, ${out.length} chars`);
