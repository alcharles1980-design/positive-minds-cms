// workspace.cjs — recreate the layout the six committed test scripts expect.
//
// The scripts were written in a workspace rooted at /home/claude/bt with:
//   v2/*.jsx                       the module sources
//   content-api/index.ts           edge fn
//   generate-questions/index.ts    edge fn
// They hardcode those paths (runtime/read/inspect/interact/visual literally say
// '/home/claude/bt/v2/'). Rather than rewrite six scripts, mirror the layout with symlinks
// so they run UNMODIFIED — the tests stay exactly what they were when they caught real bugs.
const fs = require('fs');
const path = require('path');

const REPO = process.cwd();
const BT = '/home/claude/bt';

const link = (target, linkPath) => {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try { fs.unlinkSync(linkPath); } catch {}
  fs.symlinkSync(target, linkPath);
};

// repo-local v2/ (engine.js uses a RELATIVE 'v2/core.jsx')
link(path.join(REPO, 'src'), path.join(REPO, 'v2'));
link(path.join(REPO, 'edge-functions'), path.join(REPO, 'ef'));
fs.mkdirSync(path.join(REPO, 'content-api'), { recursive: true });
fs.mkdirSync(path.join(REPO, 'generate-questions'), { recursive: true });
link(path.join(REPO, 'edge-functions/content-api.ts'),        path.join(REPO, 'content-api/index.ts'));
link(path.join(REPO, 'edge-functions/generate-questions.ts'), path.join(REPO, 'generate-questions/index.ts'));

// the absolute /home/claude/bt/v2 the other five scripts hardcode
fs.mkdirSync(BT, { recursive: true });
link(path.join(REPO, 'src'), path.join(BT, 'v2'));
link(path.join(REPO, 'node_modules'), path.join(BT, 'node_modules'));

console.log('workspace mirrored:');
console.log('  v2/                      -> src/            (20 modules)');
console.log('  content-api/index.ts     -> edge-functions/content-api.ts');
console.log('  generate-questions/…     -> edge-functions/generate-questions.ts');
console.log('  /home/claude/bt/v2       -> src/            (absolute path the scripts hardcode)');
