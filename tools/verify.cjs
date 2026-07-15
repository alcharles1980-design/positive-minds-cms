// verify.cjs — assert the whole pipeline is lossless. Run before every commit.
const { execSync } = require('child_process');
const fs = require('fs'), crypto = require('crypto');
const md5 = f => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
const snap = { jsx: md5('pm_cms.jsx'), idx: md5('index.html'), pub: md5('public/index.html') };
let fail = 0;
const check = (label, ok) => { console.log(`  ${ok ? '✓' : '✗'} ${label}`); if (!ok) fail++; };

execSync('node tools/split.cjs',    { stdio: 'ignore' });
execSync('node tools/assemble.cjs', { stdio: 'ignore' });
check('split → assemble reproduces pm_cms.jsx byte-for-byte', md5('pm_cms.jsx') === snap.jsx);

execSync('node tools/build.cjs', { stdio: 'ignore' });
check('pm_cms.jsx → index.html is deterministic',            md5('index.html') === snap.idx);
check('index.html === public/index.html',                    md5('index.html') === md5('public/index.html'));

const html = fs.readFileSync('index.html', 'utf8');
check('bundle uses classic runtime (React.createElement)',   /React\.createElement/.test(html));
console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nPIPELINE VERIFIED — safe to commit');
process.exit(fail ? 1 : 0);
