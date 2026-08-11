// content-api — the sync API for external backends (e.g. Firebase).
//
// One well-designed content shape, plus everything a client needs to sync efficiently:
//   • GET ?manifest=1              → lightweight version manifest (global + per-pack versions)
//   • GET  (default)               → full published content (packs + questions, levels expanded)
//   • GET ?since=<iso|epoch>       → INCREMENTAL: only packs/questions changed since + deletions
//   • GET ?packs=slug1,slug2       → restrict to specific packs (by slug)
//   • GET ?levels=1,2,3            → restrict expanded level-variations to these levels
//   • GET ?format=xml              → XML instead of JSON (any of the above)
//   • GET ?health=1                → liveness probe
//
// CHOOSING WHAT YOU PULL:
//   • GET ?include=a,b,c           → pick the blocks you want. Any of:
//         packs      pack records (slug, name, description, emoji, colour, difficulty, version)
//         questions  questions nested inside their pack (implies packs)
//         levels     the level DEFINITIONS (the ladder itself, so a client can label/render)
//         variants   the pre-rendered per-level sentence variants on each question. THE HEAVY ONE
//                    — omit it and the payload shrinks by roughly 10x if you mask client-side.
//         stats      full CMS content status: pack/question/level counts, review-queue totals,
//                    and per-pack live/pending/approved/rejected with descriptions and versions
//         deletions  tombstones (automatic with ?since)
//     Default (?include absent) = packs,questions,levels,variants — byte-identical to before, so
//     nothing that already polls this endpoint changes behaviour.
//   • GET ?include=stats           → status ONLY, no content. Cheap enough to poll for a dashboard.
//   • GET ?shape=nested|keyed|flat → nested (default, questions inside packs);
//         keyed = packs as an object keyed by slug, which is what Firebase/Firestore wants;
//         flat  = one array of questions each carrying its pack, for a plain table or SQL import.
//
// THE ETAG COVERS EVERY PARAMETER ABOVE. It must: a 304 is a promise that the body you already
// have is still correct, and if the key ignored ?include or ?shape we would answer "unchanged" to
// a client asking a different question.
//
// Efficiency: every response carries an ETag (a hash of global_version + query shape).
// Send it back as `If-None-Match` and unchanged content returns 304 Not Modified (no body).
//
// Auth: OPTIONAL. Set the CONTENT_API_KEY secret to require a key (via `X-API-Key` header or
// `?key=`). If the secret is unset, the endpoint is public (read-only, published content only).
//
// Works both server-to-server (Firebase Cloud Functions) and from the client (CORS = *).
//
// The rendering engine (maskWord / resolveSlots / resolveFrameMap / buildLevelVariants) is a
// byte-for-byte mirror of the CMS client engine and the game-feed edge fn — do not diverge.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const API_KEY = Deno.env.get('CONTENT_API_KEY') || ''; // optional; empty ⇒ public

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...cors, 'Content-Type': 'application/json', ...extra } });
const xmlResp = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...cors, 'Content-Type': 'application/xml; charset=utf-8', ...extra } });

// Stable, cheap hash for ETags (FNV-1a → hex).
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

// Compare an incoming If-None-Match against our ETag, tolerant of the weak-validator "W/"
// prefix (the edge platform wraps our ETag as W/"..."), surrounding quotes, and a "*" match.
function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const norm = (s: string) => s.trim().replace(/^W\//i, '').replace(/^"|"$/g, '');
  const target = norm(etag);
  return ifNoneMatch.split(',').some((tok) => { const t = tok.trim(); return t === '*' || norm(t) === target; });
}

async function fetchAll(db: any, table: string, filters: Array<[string, string, any]> = []) {
  const out: any[] = []; const size = 1000; let from = 0;
  for (let i = 0; i < 1000; i++) {
    let q = db.from(table).select('*').range(from, from + size - 1);
    if (table === 'pm_packs' || table === 'pm_questions') q = q.order('sort_order');
    else if (table === 'pm_levels' || table === 'pm_question_levels') q = q.order('level');
    for (const [col, op, val] of filters) q = (q as any)[op](col, val);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return out;
}

// ---- Rendering engine (MUST mirror the CMS client + game-feed byte-for-byte) ----
function maskWord(word: string, letters: number, position = 'end', grouping = 'grouped') {
  word = (word || '____').toUpperCase();
  const n = word.length;
  letters = Math.max(0, Math.min(letters, n));
  if (letters === 0) return word;
  if (letters >= n) return '_'.repeat(Math.max(3, n));
  let idx: number[] = [];
  if (grouping === 'spread' && letters >= 2) {
    const step = (n - 1) / letters; const picks = new Set<number>();
    for (let k = 0; k < letters; k++) { let p = Math.round(step * (k + 0.5)); p = Math.max(0, Math.min(n - 1, p)); while (picks.has(p)) p = (p + 1) % n; picks.add(p); }
    idx = [...picks].sort((a, b) => a - b);
  } else {
    let start: number;
    if (position === 'start') start = 0;
    else if (position === 'end') start = n - letters;
    else if (position === 'middle') start = Math.floor((n - letters) / 2);
    else { let seed = 0; for (let i = 0; i < word.length; i++) seed = (seed * 31 + word.charCodeAt(i)) >>> 0; start = seed % (n - letters + 1); }
    for (let k = 0; k < letters; k++) idx.push(start + k);
  }
  const chars = word.split(''); for (const i of idx) chars[i] = '_'; return chars.join('');
}

function resolveSlots(template: string, frameSlots: any, level: number) {
  if (!template) return '';
  return template.replace(/\{([a-zA-Z][\w-]*)\}/g, (m, token) => {
    if (token === 'blank') return m;
    const slot = frameSlots && frameSlots[token];
    if (!slot) return token;
    const byLevel = slot.byLevel || {};
    if (byLevel[level] != null && byLevel[level] !== '') return byLevel[level];
    const pool = Array.isArray(slot.pool) ? slot.pool.filter(Boolean) : [];
    if (pool.length === 0) return token;
    if (pool.length === 1) return pool[0];
    let seed = level | 0;
    for (let i = 0; i < token.length; i++) seed = (seed * 31 + token.charCodeAt(i)) >>> 0;
    return pool[seed % pool.length];
  });
}

function resolveFrameMap(template: string, frameSlots: any, level: number) {
  const map: Record<string, string> = {};
  if (!template) return map;
  for (const m of template.matchAll(/\{([a-zA-Z][\w-]*)\}/g)) {
    const token = m[1];
    if (token === 'blank') continue;
    const slot = frameSlots && frameSlots[token];
    if (!slot) { map[token] = token; continue; }
    const byLevel = slot.byLevel || {};
    if (byLevel[level] != null && byLevel[level] !== '') { map[token] = byLevel[level]; continue; }
    const pool = Array.isArray(slot.pool) ? slot.pool.filter(Boolean) : [];
    if (pool.length === 0) { map[token] = token; continue; }
    if (pool.length === 1) { map[token] = pool[0]; continue; }
    let seed = level | 0;
    for (let i = 0; i < token.length; i++) seed = (seed * 31 + token.charCodeAt(i)) >>> 0;
    map[token] = pool[seed % pool.length];
  }
  return map;
}

function buildLevelVariants(q: any, levels: any[], overrides: Record<number, any>) {
  return (levels || []).map((lvl) => {
    const ov = overrides[lvl.level] || {};
    const template = ov.template ?? q.template;
    const answer = ov.answer ?? q.answer;
    const alt = ov.alt_answer ?? q.alt_answer;
    const word = (answer || '').toUpperCase();
    const isWord = lvl.hidden_mode === 'word';
    const letters = ov.letters_hidden ?? (isWord ? word.length : Math.min(lvl.letters_hidden_default || 2, Math.max(1, word.length - 1)));
    // Precedence MUST match the client: override -> question's own -> level default -> hard default.
    const position = ov.letter_position ?? q.letter_position ?? lvl.letter_position ?? 'end';
    const grouping = ov.letter_grouping ?? q.letter_grouping ?? lvl.letter_grouping ?? 'grouped';
    const whole = isWord || letters >= word.length;
    const blank = whole ? '_'.repeat(Math.max(3, word.length)) : maskWord(word, letters, position, grouping);
    const withSlots = resolveSlots(template, q.frame_slots, lvl.level);
    const sentence = withSlots.replace(/\{blank\}/g, blank);
    const frames = resolveFrameMap(template, q.frame_slots, lvl.level);
    return {
      level: lvl.level, level_name: lvl.name, sentence, blank,
      target: { word, altWord: (alt || '').toUpperCase(), blankShape: blank, wholeWord: whole, lettersHidden: whole ? word.length : letters, position, grouping },
      frames,
      answer, alt_answer: alt,
      options: [answer, alt].filter(Boolean).map((w: string) => (w as string).toUpperCase()),
      enabled: ov.enabled !== false,
    };
  }).filter((v) => v.enabled);
}

// ---- The single, well-designed content shape ----
function shapePack(p: any) {
  return {
    slug: p.slug,
    name: p.name,
    emoji: p.emoji,
    description: p.description,
    color: p.color,
    difficulty: p.difficulty,
    tags: p.tags || [],
    level: p.level ?? 1,
    content_version: p.content_version ?? 0,
    updated_at: p.updated_at,
  };
}
function shapeQuestion(q: any) {
  return {
    id: q.id,
    template: q.template,
    answer: q.answer,
    alt_answer: q.alt_answer,
    level: q.effective_level,
    frames: (q.frame_slots && Object.keys(q.frame_slots).length) ? q.frame_slots : undefined,
    levels: q.levels,   // the 10 rendered variations
    updated_at: q.updated_at,
  };
}

// ---- XML serialization (mirror of the client/game-feed toXml) ----
const XML_ESC = (s: any) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const singular = (k: string) => k === 'levels' ? 'levelVariant' : k === 'options' ? 'option'
  : k.endsWith('ies') ? k.slice(0, -3) + 'y' : k.endsWith('s') ? k.slice(0, -1) : k;
const safeTag = (k: string) => /^[a-zA-Z_][\w.-]*$/.test(k) ? k : 'item';
const toXmlNode = (key: string, val: any, indent: number): string => {
  const pad = '  '.repeat(indent); const tag = safeTag(key);
  if (val === null || val === undefined) return `${pad}<${tag}/>`;
  if (Array.isArray(val)) {
    if (val.length === 0) return `${pad}<${tag}/>`;
    const item = singular(tag);
    return `${pad}<${tag}>\n` + val.map((v) => toXmlNode(item, v, indent + 1)).join('\n') + `\n${pad}</${tag}>`;
  }
  if (typeof val === 'object') {
    const inner = Object.entries(val).filter(([, v]) => v !== undefined).map(([k, v]) => toXmlNode(k, v, indent + 1)).join('\n');
    return `${pad}<${tag}>\n${inner}\n${pad}</${tag}>`;
  }
  return `${pad}<${tag}>${XML_ESC(val)}</${tag}>`;
};
const toXml = (obj: any, rootTag = 'content') => {
  const body = Array.isArray(obj) ? obj.map((v) => toXmlNode('item', v, 1)).join('\n')
    : Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => toXmlNode(k, v, 1)).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootTag}>\n${body}\n</${rootTag}>`;
};

// Recursively drop undefined so JSON stays clean.
const clean = (o: any): any => JSON.parse(JSON.stringify(o));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  const p = url.searchParams;

  if (p.get('health')) {
    return json({ ok: true, service: 'content-api', auth_required: !!API_KEY, time: new Date().toISOString() });
  }

  // ---- Optional API-key auth ----
  if (API_KEY) {
    const provided = req.headers.get('x-api-key') || p.get('key') || '';
    if (provided !== API_KEY) {
      return json({ error: 'Unauthorized', hint: 'Provide the API key via the X-API-Key header or ?key=' }, 401);
    }
  }

  const wantXml = (p.get('format') || '').toLowerCase() === 'xml';
  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    // Global version underpins every ETag.
    const { data: manifestData, error: mErr } = await db.rpc('pm_content_manifest');
    if (mErr) throw mErr;
    const globalVersion: number = manifestData?.global_version ?? 0;

    // ---- MANIFEST ----
    if (p.get('manifest')) {
      const etag = '"m-' + hash(String(globalVersion)) + '"';
      if (etagMatches(req.headers.get('if-none-match'), etag)) {
        return new Response(null, { status: 304, headers: { ...cors, ETag: etag } });
      }
      const body = wantXml ? xmlResp(toXml(manifestData, 'manifest')) : json(manifestData);
      body.headers.set('ETag', etag);
      body.headers.set('Cache-Control', 'public, max-age=30');
      return body;
    }

    // ---- Query options (apply to both full + incremental) ----
    // ---- what to include -------------------------------------------------------------------
    const DEFAULT_INCLUDE = ['packs', 'questions', 'levels', 'variants'];
    const rawInclude = (p.get('include') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const inc = new Set(rawInclude.length ? (rawInclude.includes('all')
        ? ['packs', 'questions', 'levels', 'variants', 'stats', 'deletions']
        : rawInclude) : DEFAULT_INCLUDE);
    if (inc.has('questions')) inc.add('packs');     // questions live inside packs
    if (inc.has('variants'))  inc.add('questions'); // variants hang off questions
    const shape = (p.get('shape') || 'nested').toLowerCase();
    if (!['nested', 'keyed', 'flat'].includes(shape)) {
      return json({ error: `Unknown ?shape=${shape}. Use nested, keyed or flat.` }, 400);
    }

    // RELEASE GATE — OPT-IN, and off by default on purpose.
    // released_version tracks what has been PUSHED to a configured sync target (publish2 calls
    // pm_mark_released after a successful sync). A PULL is not a release, so pulling has never been
    // gated — and turning that on by default would hide every live question from the game until
    // somebody pressed a button they have never needed to press.
    // ?released=1 is for a client that wants only content a human has deliberately released:
    // released_version >= content_version. Anything edited since the last release drops out until
    // it is released again.
    const releasedOnly = ['1', 'true', 'yes'].includes((p.get('released') || '').toLowerCase());
    const packSlugs = (p.get('packs') || '').split(',').map(s => s.trim()).filter(Boolean);
    const levelNums = (p.get('levels') || '').split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
    const sinceRaw = p.get('since');
    let since: Date | null = null;
    if (sinceRaw) {
      // Accept ISO 8601 or a unix epoch (seconds).
      const asNum = Number(sinceRaw);
      since = (!isNaN(asNum) && sinceRaw.trim() !== '') ? new Date(asNum * 1000) : new Date(sinceRaw);
      if (isNaN(since.getTime())) return json({ error: 'Invalid ?since — use ISO 8601 or a unix epoch (seconds).' }, 400);
    }

    // ETag captures the exact request shape (mode + filters) so different queries don't collide.
    const shapeKey = [
      since ? 'inc' : 'full', sinceRaw || '', packSlugs.join('.'), levelNums.join('.'), wantXml ? 'xml' : 'json',
      releasedOnly ? 'rel' : 'any',
      // Without these two a client that switches ?include or ?shape gets a 304 and keeps rendering
      // the previous shape — a stale-cache bug that would look like the parameter being ignored.
      [...inc].sort().join('+'), shape,
    ].join('|');
    const etag = '"c-' + hash(globalVersion + '|' + shapeKey) + '"';
    // For a FULL (non-incremental) request, a matching ETag means nothing changed → 304.
    // For incremental, the ?since already narrows the result, so we still honour If-None-Match
    // (unchanged global_version ⇒ nothing new since last identical poll).
    if (etagMatches(req.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers: { ...cors, ETag: etag } });
    }

    // ---- stats: answerable without touching content at all ----
    // Fetched first and independently, so ?include=stats alone never loads a question.
    let stats: any = null;
    if (inc.has('stats')) {
      const { data: st, error: sErr } = await db.rpc('pm_content_stats');
      if (sErr) return json({ error: 'stats unavailable: ' + sErr.message }, 500);
      stats = st;
    }
    // Nothing else requested? Answer now rather than reading every pack and question to throw away.
    if (!inc.has('packs') && !inc.has('levels')) {
      const statsOnly = clean({
        meta: {
          service: 'content-api', generated_at: new Date().toISOString(),
          global_version: globalVersion, global_updated_at: manifestData?.global_updated_at,
          mode: 'stats', include: [...inc].sort(),
        },
        stats,
      });
      const so = wantXml ? xmlResp(toXml(statsOnly, 'content')) : json(statsOnly);
      so.headers.set('ETag', etag);
      so.headers.set('Cache-Control', 'public, max-age=30');
      return so;
    }

    // ---- Load published content ----
    let packs = await fetchAll(db, 'pm_packs', [['status', 'eq', 'published']]);
    if (packSlugs.length) packs = packs.filter(p => packSlugs.includes(p.slug));
    if (releasedOnly) packs = packs.filter(p => (p.released_version ?? 0) >= (p.content_version ?? 0));
    const packById: Record<string, any> = {};
    const publishedPackIds = new Set<string>();
    for (const pk of packs) { packById[pk.id] = pk; publishedPackIds.add(pk.id); }

    let questions = await fetchAll(db, 'pm_questions', [['status', 'eq', 'active']]);
    questions = questions.filter(q => publishedPackIds.has(q.pack_id));

    // Effective level per question.
    for (const q of questions) q.effective_level = q.level ?? packById[q.pack_id]?.level ?? 1;

    // Level definitions (optionally filtered to requested levels for the expansion).
    let levels = await fetchAll(db, 'pm_levels');
    if (levelNums.length) levels = levels.filter(l => levelNums.includes(l.level));
    const ovRows = await fetchAll(db, 'pm_question_levels');
    const ovByQ: Record<string, Record<number, any>> = {};
    for (const r of ovRows) { (ovByQ[r.question_id] ||= {})[r.level] = r; }
    // The pre-rendered variants are by far the biggest thing in the payload. Only build them if
    // asked — a client that masks its own words does not want ~10x the bytes.
    if (inc.has('variants')) {
      for (const q of questions) q.levels = buildLevelVariants(q, levels, ovByQ[q.id] || {});
    }

    // ---- INCREMENTAL: narrow to changed rows + gather deletions ----
    let deletions: any[] = [];
    if (since) {
      const sinceIso = since.toISOString();
      // A pack counts as "changed" if it OR any of its questions changed since.
      const changedQ = questions.filter(q => q.updated_at && new Date(q.updated_at) > since!);
      const changedPackIds = new Set(changedQ.map(q => q.pack_id));
      packs = packs.filter(pk => (pk.updated_at && new Date(pk.updated_at) > since!) || changedPackIds.has(pk.id));
      const keepPackIds = new Set(packs.map(pk => pk.id));
      // Return the full current question set for any pack that's in the changed list (so the
      // client can replace that pack wholesale — simplest correct merge), else nothing.
      questions = questions.filter(q => keepPackIds.has(q.pack_id));

      // Deletions since the cursor (scoped to published packs where known, plus all pack deletions).
      const delRows = await fetchAll(db, 'pm_deletions', [['deleted_at', 'gt', sinceIso]]);
      deletions = delRows.map(d => ({ type: d.entity_type, id: d.entity_id, pack_id: d.pack_id, slug: d.slug, deleted_at: d.deleted_at }));
    }

    // ---- Assemble the response ----
    const byPack: Record<string, any[]> = {};
    for (const q of questions) (byPack[q.pack_id] ||= []).push(q);

    const packsOut = packs.map(pk => ({
      ...shapePack(pk),
      ...(inc.has('questions') ? { questions: (byPack[pk.id] || []).map(shapeQuestion) } : {}),
    }));

    // ---- SHAPE ------------------------------------------------------------------------------
    // nested (default) — packs with their questions inside. Unchanged from before.
    // keyed           — { "calmness": {...}, "focus": {...} }. Firestore stores documents by key,
    //                   so a keyed object drops straight in without a client-side reindex.
    // flat            — one array of questions, each carrying pack_slug/pack_name. For a SQL
    //                   import or a plain table, where nesting is just something to undo.
    let packsShaped: any = packsOut;
    let flatQuestions: any[] | null = null;
    if (shape === 'keyed') {
      packsShaped = {};
      for (const pk of packsOut) packsShaped[pk.slug] = pk;
    } else if (shape === 'flat') {
      flatQuestions = [];
      for (const pk of packsOut) {
        const { questions: qs, ...packFields } = pk as any;
        for (const q of (qs || [])) {
          flatQuestions.push({ pack_slug: packFields.slug, pack_name: packFields.name, ...q });
        }
      }
    }

    const payload: any = {
      meta: {
        service: 'content-api',
        generated_at: new Date().toISOString(),
        global_version: globalVersion,
        global_updated_at: manifestData?.global_updated_at,
        levels_version: manifestData?.levels_version,
        mode: since ? 'incremental' : 'full',
        since: sinceRaw || null,
        pack_count: packsOut.length,
        question_count: questions.length,
        include: [...inc].sort(),
        shape,
        released_only: releasedOnly,
        filtered: { packs: packSlugs.length ? packSlugs : undefined, levels: levelNums.length ? levelNums : undefined },
      },
      ...(stats ? { stats } : {}),
      // The level DEFINITIONS themselves (rules), so a client can render/label without guessing.
      // Omitted entirely when ?include leaves out `levels` — clean() drops undefined keys, but
      // relying on key ORDER for that would be a trap, so the conditional is explicit.
      levels: inc.has('levels') ? levels.map(l => ({
        level: l.level, name: l.name, tagline: l.tagline, theme: l.theme, age_hint: l.age_hint,
        hidden_mode: l.hidden_mode, letters_hidden_default: l.letters_hidden_default,
        letter_position: l.letter_position, letter_grouping: l.letter_grouping, color: l.color,
        min_word_len: l.min_word_len, max_word_len: l.max_word_len,
        allow_multiword: l.allow_multiword, vocab_rule: l.vocab_rule,
        updated_at: l.updated_at,
      })) : undefined,
      ...(shape === 'flat' ? { questions: flatQuestions } : { packs: packsShaped }),
      ...(since ? { deletions } : {}),
    };

    const out = wantXml ? xmlResp(toXml(clean(payload), 'content')) : json(clean(payload));
    out.headers.set('ETag', etag);
    out.headers.set('Cache-Control', 'public, max-age=30');
    return out;
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
