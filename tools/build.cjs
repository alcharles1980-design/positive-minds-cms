// build.cjs — pm_cms.jsx  ->  index.html + public/index.html
// VERIFIED to reproduce the shipped index.html byte-for-byte.
//
// Babel settings are NOT arbitrary — they were recovered by bisection against the shipped build:
//   runtime: 'classic'   → React.createElement. The automatic runtime emits `import jsxDEV`,
//                          which breaks a plain <script> and yields a blank "Loading…" screen.
//   development: false   → no dev-runtime instrumentation.
//   compact: true        → matches the shipped whitespace exactly.
//   comments: true       → the shipped bundle KEEPS comments. Stripping them changes nothing
//                          semantically but breaks byte-equality with the deployed artifact.
const fs = require('fs');
const babel = require('@babel/core');

const HEAD = fs.readFileSync('.build/shell_head.html', 'utf8');
const TAIL = fs.readFileSync('.build/shell_tail.html', 'utf8');
const src  = fs.readFileSync('pm_cms.jsx', 'utf8');

const { code } = babel.transformSync(src, {
  presets: [['@babel/preset-react', { runtime: 'classic', development: false }]],
  compact: true, comments: true, configFile: false, babelrc: false,
});

// ---- GUARDS ----
// The embedded docs are template literals inside the bundle and legitimately contain the WORDS
// "jsxDEV" and "import" as English prose. A substring check therefore always false-alarms (this is
// the known bogus warning the old assemble step emitted). Parse the OUTPUT and count real AST nodes.
const ast = babel.parseSync(code, { configFile: false, babelrc: false, sourceType: 'script' });
const realImports = ast.program.body.filter(n => n.type === 'ImportDeclaration').length;
const realJsxDev  = (code.match(/_?jsxDEV\s*\(/g) || []).length;
const createEls   = (code.match(/React\.createElement/g) || []).length;

if (realImports) throw new Error(`ABORT: ${realImports} real ESM import(s) — breaks a plain <script>`);
if (realJsxDev)  throw new Error(`ABORT: ${realJsxDev} real jsxDEV call(s) — wrong Babel runtime`);
if (createEls < 100) throw new Error(`ABORT: only ${createEls} React.createElement — not classic runtime`);

const html = HEAD + '\n' + code + '\n' + TAIL;
fs.writeFileSync('index.html', html);
fs.writeFileSync('public/index.html', html);   // the two MUST stay in sync

const stamp = (src.match(/build:\s*"([^"]+)"/) || [])[1];
console.log(`✓ build ${stamp} — ${html.length.toLocaleString()} chars · ${createEls} createElement · 0 jsxDEV · 0 imports · index.html + public/index.html in sync`);
