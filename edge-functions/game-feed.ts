// game-feed — SHAPED exports. One saved profile per target engine.
//
//   • GET ?list=1                  → the available profiles
//   • GET ?profile=<id|name>       → export in that profile's shape (default: first built-in)
//   • GET ?packs=slug1,slug2       → narrow to specific packs (same param name as content-api)
//   • GET ?stats=1                 → include the CMS content status alongside the content
//   • GET ?stats=only              → the status and NOTHING else — cheap to poll for a dashboard
//   • GET ?format=xml              → XML instead of JSON
//   • GET ?health=1                → liveness probe
//
// A PROFILE defines the SHAPE: rename every field (template->sentence, answer->primaryWord),
// transform values (upper/lower/slug), choose nested vs keyed vs flat, set the root and questions
// keys, and filter by status. Stored in pm_export_profiles.spec; spec.include_stats turns stats on
// permanently for that profile, and ?stats= overrides it per request.
//
// WHICH ENDPOINT DO I WANT?
//   content-api  — SYNCING. Versioning, ?since incremental, deletions, ETag/304, ?include blocks.
//                  Use it for the recurring pull that keeps a backend in step.
//   game-feed    — SHAPING. Field names and structure for one specific engine, saved as a profile.
//                  Use it when the consumer needs ITS vocabulary, not ours.
// Both read the same content and both can return the same stats block.
// transformed through a named export profile. No auth required.
// Add ?format=xml for XML output (default JSON).
//
// PROVENANCE: recovered verbatim from the LIVE deployment (project tytrmjjucqijzcrbwjfm,
// slug "game-feed", version 11) — it was deployed but had never been committed to the repo.
//
// ⚠️ PARITY NOTE: this file carries its OWN copy of the rendering engine
// (maskWord / resolveSlots / resolveFrameMap / buildLevelVariants). maskWord/resolveSlots/
// resolveFrameMap are byte-identical to core.jsx and content-api.ts. buildLevelVariants here
// emits a DIFFERENT output shape from content-api.ts on purpose — it returns `opts` as a joined
// "A / B" string (legacy game-feed shape), whereas content-api.ts returns an `options` array and
// a `level_name`. The MASKING is identical across both; only the serialization differs. If you
// change maskWord/resolveSlots/resolveFrameMap in one place, change it in ALL copies (core.jsx,
// content-api.ts, generate-questions.ts, mcp.ts, and here). Redeploy with:
//   supabase functions deploy game-feed --project-ref tytrmjjucqijzcrbwjfm --no-verify-jwt
//
// This is the legacy feed. content-api is the newer, preferred sync endpoint. Retiring game-feed
// would remove one engine copy — but confirm no live game client still pulls from it first.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { ...cors, 'Content-Type': 'application/json', ...extra } });
const xmlResp = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...cors, 'Content-Type': 'application/xml; charset=utf-8', ...extra } });

async function fetchAll(db: any, table: string, statusCol?: string, statusVal?: string) {
  const out: any[] = []; const size = 1000; let from = 0;
  for (let i = 0; i < 1000; i++) {
    let q = db.from(table).select('*').range(from, from + size - 1);
    if (table === 'pm_packs' || table === 'pm_questions') q = q.order('sort_order');
    else if (table === 'pm_levels' || table === 'pm_question_levels') q = q.order('level');
    if (statusCol && statusVal) q = q.eq(statusCol, statusVal);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < size) break;
    from += size;
  }
  return out;
}

// ---- Blank-shape masking (MUST mirror the client maskWord exactly) ----
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

// ---- Frame-word slot resolution (MUST mirror the client resolveSlots exactly) ----
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

// Structured token->word map for a level (mirror of client resolveFrameMap).
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
      // Explicit target so the game never parses the sentence to find the guess word.
      target: { word, altWord: (alt || '').toUpperCase(), blankShape: blank, wholeWord: whole, lettersHidden: whole ? word.length : letters, position, grouping },
      frames,
      answer, alt_answer: alt,
      opts: [answer, alt].filter(Boolean).map((w: string) => w.toUpperCase()).join(' / '), enabled: ov.enabled !== false };
  }).filter((v) => v.enabled);
}

// ---- XML serialization (mirror of the client toXml) ----
const XML_ESC = (s: any) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const singular = (k: string) => k === 'levels' ? 'levelVariant' : k.endsWith('ies') ? k.slice(0, -3) + 'y' : k.endsWith('s') ? k.slice(0, -1) : k;
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
    const inner = Object.entries(val).map(([k, v]) => toXmlNode(k, v, indent + 1)).join('\n');
    return `${pad}<${tag}>\n${inner}\n${pad}</${tag}>`;
  }
  return `${pad}<${tag}>${XML_ESC(val)}</${tag}>`;
};
const toXml = (obj: any, rootTag = 'gameContent') => {
  const body = Array.isArray(obj) ? obj.map((v) => toXmlNode('item', v, 1)).join('\n')
    : Object.entries(obj).map(([k, v]) => toXmlNode(k, v, 1)).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootTag}>\n${body}\n</${rootTag}>`;
};

const applyTransform = (val: any, t: string) => {
  if (val == null) return val;
  if (typeof val === 'object') return val;
  switch (t) { case 'upper': return String(val).toUpperCase(); case 'lower': return String(val).toLowerCase(); case 'trim': return String(val).trim(); default: return val; }
};
const mapValue = (field: string, val: any, vm: any) => {
  const m = vm?.[field];
  if (!m) return val;
  const key = (typeof val === 'object' || val == null) ? null : val;
  return (key != null && key in m) ? m[key] : val;
};
const projectRow = (row: any, fields: any[], vm: any) => {
  const out: any = {};
  for (const f of fields || []) { if (!f.to) continue; let v = applyTransform(row[f.from], f.transform || 'none'); v = mapValue(f.to, v, vm); out[f.to] = v; }
  return out;
};
const build = (spec: any, packs: any[], byPack: Record<string, any[]>) => {
  const vm = spec.value_maps || {};
  const qKey = spec.questions_key || 'questions';
  const projectQ = (q: any) => {
    const base = projectRow(q, spec.question_fields, vm);
    if (spec.expand_levels && q.levels) base.levels = q.levels;
    if (spec.include_frames && q.frame_slots && Object.keys(q.frame_slots).length) base.frameSlots = q.frame_slots;
    return base;
  };
  if (spec.structure === 'flat') {
    const arr: any[] = [];
    for (const p of packs) { const pp = projectRow(p, spec.pack_fields, vm); for (const q of byPack[p.id] || []) arr.push({ ...pp, ...projectQ(q) }); }
    return spec.root_key ? { [spec.root_key]: arr } : arr;
  }
  if (spec.structure === 'keyed') {
    const obj: any = {}; const keyBy = spec.key_by || 'slug';
    for (const p of packs) obj[p[keyBy]] = { ...projectRow(p, spec.pack_fields, vm), [qKey]: (byPack[p.id] || []).map(projectQ) };
    return spec.root_key ? { [spec.root_key]: obj } : obj;
  }
  const arr = packs.map((p) => ({ ...projectRow(p, spec.pack_fields, vm), [qKey]: (byPack[p.id] || []).map(projectQ) }));
  return spec.root_key ? { [spec.root_key]: arr } : arr;
};

// ============================================================================================
// SERVER-SIDE SYNC (?sync=<target name|id>)
//
// The CMS's Sync button runs in the BROWSER: it reads content, reshapes it and posts to the target.
// That works, but only while a page is open — so nothing else can trigger a sync, and a connector
// cannot. This is the same job done on the server, so the CMS and Claude can both reach it.
//
// DELIBERATELY NOT A PORT OF THE TRANSFORM. build() above is the same function game-feed already
// uses for every export, so the shape sent to Firebase is by construction the shape a caller would
// get from ?profile=. A second copy of the builder is exactly the drift this codebase has a rule
// about (4.42) — the only NEW code here is the write planner and the HTTP writers.
//
// THE BROWSER PATH IS UNTOUCHED. Both exist; the browser one keeps working while this is proven.
const resolvePath = (tpl: string, ctx: Record<string, any>) =>
  (tpl || '').replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? '');

const planWrites = (cfg: any, packs: any[], byPack: Record<string, any[]>, spec: any) => {
  const layout = cfg.layout || 'per-pack';
  const ops: any[] = [];
  if (layout === 'single-doc') {
    ops.push({ path: cfg.singlePath || 'content/all', data: build(spec, packs, byPack) });
  } else if (layout === 'per-question') {
    for (const p of packs) {
      for (const q of byPack[p.id] || []) {
        const one = build({ ...spec, structure: 'flat', root_key: null }, [p], { [p.id]: [q] });
        ops.push({ path: resolvePath(cfg.questionPath || 'questions/{id}', { id: q.id, slug: p.slug }),
                   data: Array.isArray(one) ? one[0] : one });
      }
    }
  } else {
    for (const p of packs) {
      const one = build({ ...spec, structure: 'nested', root_key: null }, [p], byPack);
      ops.push({ path: resolvePath(cfg.packPath || 'packs/{slug}', { slug: p.slug, id: p.id }),
                 data: Array.isArray(one) ? one[0] : one });
    }
  }
  return ops;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  if (url.searchParams.get('health')) return json({ ok: true, service: 'game-feed', time: new Date().toISOString() });

  const wantXml = (url.searchParams.get('format') || '').toLowerCase() === 'xml';
  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  try {
    if (url.searchParams.get('list')) {
      const { data } = await db.from('pm_export_profiles').select('id,name,description,is_builtin').order('created_at');
      return json({ profiles: data || [] });
    }

    const pid = url.searchParams.get('profile');
    let pQ = db.from('pm_export_profiles').select('*');
    if (pid) { const isUuid = /^[0-9a-f]{8}-/.test(pid); pQ = isUuid ? pQ.eq('id', pid) : pQ.eq('name', pid); }
    else pQ = pQ.eq('is_builtin', true).order('created_at');
    const { data: profiles } = await pQ.limit(1);
    const profile = profiles?.[0];
    if (!profile) return json({ error: 'Profile not found', hint: 'Try ?list=1 to see available profiles' }, 404);

    const spec = profile.spec || {};
    const filters = spec.filters || {};

    // STATS. A profile can turn this on permanently (spec.include_stats), or a caller can ask for
    // it per request with ?stats=1 / ?stats=0. The query parameter wins, so a saved profile never
    // stops you asking a different question today.
    const statsParam = url.searchParams.get('stats');
    const wantStats = statsParam !== null ? (statsParam !== '0' && statsParam !== 'false')
                                          : !!spec.include_stats;
    let stats: any = null;
    if (wantStats) {
      const { data: st } = await db.rpc('pm_content_stats');
      stats = st;
    }
    // Stats WITHOUT content: ?stats=only. Cheap enough for a dashboard to poll on a timer.
    if ((statsParam || '').toLowerCase() === 'only') {
      const body = { meta: { service: 'game-feed', generated_at: new Date().toISOString(), mode: 'stats' }, stats };
      return wantXml ? xmlResp(toXml(body, 'feed')) : json(body);
    }

    let packs = await fetchAll(db, 'pm_packs', filters.status ? 'status' : undefined, filters.status);
    let questions = await fetchAll(db, 'pm_questions', filters.question_status ? 'status' : undefined, filters.question_status);

    // AD-HOC NARROWING, same parameter names as content-api so the two endpoints do not disagree
    // about what ?packs means. A profile defines the SHAPE; these choose the SUBSET.
    // RELEASE GATE — OPT-IN, and off by default on purpose.
    // released_version tracks what has been PUSHED to a configured sync target (publish2 calls
    // pm_mark_released after a successful sync). A PULL is not a release, so pulling has never been
    // gated — and turning that on by default would hide every live question from the game until
    // somebody pressed a button they have never needed to press.
    // ?released=1 is for a client that wants only content a human has deliberately released:
    // released_version >= content_version. Anything edited since the last release drops out until
    // it is released again.
    const releasedOnly = ['1', 'true', 'yes'].includes((url.searchParams.get('released') || '').toLowerCase());
    const packSlugs = (url.searchParams.get('packs') || '').split(',').map(x => x.trim()).filter(Boolean);
    if (releasedOnly) {
      packs = packs.filter((p: any) => (p.released_version ?? 0) >= (p.content_version ?? 0));
      const rel = new Set(packs.map((p: any) => p.id));
      questions = questions.filter((q: any) => rel.has(q.pack_id));
    }
    if (packSlugs.length) {
      packs = packs.filter((p: any) => packSlugs.includes(p.slug));
      const keep = new Set(packs.map((p: any) => p.id));
      questions = questions.filter((q: any) => keep.has(q.pack_id));
    }

    const packLevel: Record<string, number> = {};
    for (const p of packs) packLevel[p.id] = p.level || 1;
    for (const q of questions) {
      q.effective_level = q.level ?? packLevel[q.pack_id] ?? 1;
      q.base_sentence = resolveSlots(q.template || '', q.frame_slots, q.effective_level).replace(/\{blank\}/g, (q.answer || '').toUpperCase());
    }

    if (spec.expand_levels) {
      const levels = await fetchAll(db, 'pm_levels');
      const ovRows = await fetchAll(db, 'pm_question_levels');
      const ovByQ: Record<string, Record<number, any>> = {};
      for (const r of ovRows) { (ovByQ[r.question_id] ||= {})[r.level] = r; }
      for (const q of questions) q.levels = buildLevelVariants(q, levels, ovByQ[q.id] || {});
    }

    const byPack: Record<string, any[]> = {};
    for (const q of questions) (byPack[q.pack_id] ||= []).push(q);
    const packList = packs.filter((p) => (byPack[p.id]?.length || 0) > 0 || spec.include_empty || filters.include_empty);
    const body = build(spec, packList, byPack);

    // Record the pull, fire and forget — a logging failure must never fail the sync it observes.
    if (packList.length) {
      const clientName = (url.searchParams.get('client') || req.headers.get('user-agent') || '').slice(0, 80) || null;
      fetch(`${SUPABASE_URL}/rest/v1/pm_sync_log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SERVICE_KEY,
                   Authorization: `Bearer ${SERVICE_KEY}`, Prefer: 'return=minimal' },
        body: JSON.stringify({
          direction: 'pull', endpoint: 'game-feed', client: clientName,
          profile_id: profile.id, profile_name: profile.name,
          mode: 'full', status: 'ok',
          packs: packSlugs.length ? packSlugs : null,
          pack_count: packList.length, question_count: questions.length,
        }),
      }).catch(() => {});
    }

    // ---- SERVER SYNC ----------------------------------------------------------------------
    // ?sync=<target name or id>. Reads the target from pm_sync_targets, applies ITS pack filter,
    // writes, and records the push in pm_sync_log so the history looks identical to a browser sync.
    // ?dry=1 reports what WOULD be sent and writes nothing — the safe way to check a target.
    const syncTarget = url.searchParams.get('sync');
    if (syncTarget) {
      const dry = ['1','true','yes'].includes((url.searchParams.get('dry') || '').toLowerCase());
      const { data: targets } = await db.from('pm_sync_targets').select('*');
      const t = (targets || []).find((x: any) => x.id === syncTarget || x.name === syncTarget);
      if (!t) {
        return json({ error: `No sync target called "${syncTarget}".`,
                      available: (targets || []).map((x: any) => x.name) }, 404);
      }
      const cfg = t.config || {};

      // THE TARGET'S OWN PACK FILTER, honoured here exactly as the browser honours it. A caller
      // cannot widen it: the target's configuration is the authority on where its content goes.
      const wanted: string[] = Array.isArray(cfg.packs) ? cfg.packs.filter(Boolean) : [];

      // CALLER NARROWING — ?packs=a,b. This is a ONE-OFF subset for this call only; it changes no
      // stored configuration. It can only ever REMOVE packs from what the target would have sent,
      // never add one, so a caller cannot reach a pack the target was configured to exclude. The
      // intersection is computed against `allowed`, which is already the target's filter (or every
      // pack, if it has none), so the narrow-only property holds without a second check.
      // An unrecognised slug is an ERROR, not silently dropped: "sync just calmnes" quietly sending
      // nothing looks identical to a successful sync, and the missing content is found later by a
      // child. Fail loudly and say what was allowed.
      const allowed: string[] = wanted.length ? wanted : packList.map((p: any) => p.slug);
      const asked: string[] = (url.searchParams.get('packs') || '')
        .split(',').map((x) => x.trim()).filter(Boolean);
      const unknown = asked.filter((x) => !allowed.includes(x));
      if (asked.length && unknown.length) {
        return json({ error: `Not sendable to this target: ${unknown.join(', ')}.`,
                      allowed, note: wanted.length
                        ? 'This target has its own pack filter; a call can only narrow within it.'
                        : 'A pack must be published and in the feed to be sent.' }, 400);
      }
      const effective: string[] = asked.length ? allowed.filter((x) => asked.includes(x)) : allowed;

      const syncPacks = packList.filter((p: any) => effective.includes(p.slug));
      if (!syncPacks.length) {
        return json({ error: 'That selection matches no packs, so there is nothing to send.',
                      allowed }, 400);
      }
      const syncByPack: Record<string, any[]> = {};
      for (const p of syncPacks) syncByPack[p.id] = byPack[p.id] || [];
      const qCount = syncPacks.reduce((n: number, p: any) => n + (syncByPack[p.id] || []).length, 0);

      const ops = planWrites(cfg, syncPacks, syncByPack, spec);
      const fullBody = build(spec, syncPacks, syncByPack);
      const summary = {
        target: t.name, profile: profile.name, mode: cfg.mode || 'rtdb',
        packs: syncPacks.map((p: any) => p.slug), pack_count: syncPacks.length,
        question_count: qCount, writes: ops.length,
        filtered_by_target: wanted.length ? wanted : null,
        narrowed_by_caller: asked.length ? asked : null,
        // A partial sync leaves everything it did NOT send exactly as it was — sync never deletes.
        // Say so in the summary, because "synced" otherwise reads as "Firebase now matches the CMS".
        partial: asked.length ? 'Only these packs were sent. Everything else in Firebase is unchanged, ' +
                                'including packs that have since been edited here.' : null,
      };

      if (dry) return json({ ok: true, dry_run: true, would_send: summary,
                             note: 'Nothing was written. Drop ?dry=1 to send it.' });

      let written = 0; let err: string | null = null;
      try {
        if (cfg.mode === 'cloudfn') {
          if (!cfg.fnUrl) throw new Error('This target has no Cloud Function URL.');
          const headers: Record<string,string> = { 'Content-Type': 'application/json' };
          if (cfg.secret) headers[cfg.header || 'Authorization'] = cfg.secret;
          const r = await fetch(cfg.fnUrl, { method: 'POST', headers,
            body: JSON.stringify({ writes: ops, payload: { meta: summary, ...(fullBody as any) } }) });
          if (!r.ok) throw new Error(`Cloud Function returned HTTP ${r.status}`);
          written = ops.length;
        } else if (cfg.mode === 'rtdb') {
          const base = (cfg.rtdbUrl || '').replace(/\/$/, '');
          if (!base) throw new Error('This target has no Realtime Database URL.');
          for (const op of ops) {
            const u = `${base}/${op.path}.json${cfg.secret ? `?auth=${encodeURIComponent(cfg.secret)}` : ''}`;
            const r = await fetch(u, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                                       body: JSON.stringify(op.data) });
            if (!r.ok) throw new Error(`Realtime DB returned HTTP ${r.status} for ${op.path}`);
            written++;
          }
        } else {
          throw new Error(`Server sync does not support mode "${cfg.mode}" yet. Use the browser Sync button for this target.`);
        }
      } catch (e) {
        err = String((e as any)?.message || e);
      }

      // Record it either way — a failed sync is exactly what you want in the history.
      await db.from('pm_sync_log').insert({
        direction: 'push', channel: 'server', mode: 'server',
        profile_id: profile.id, profile_name: profile.name, target_name: t.name,
        status: err ? 'error' : 'success',
        pack_count: syncPacks.length, question_count: qCount,
        packs: effective,   // what ACTUALLY went, not the target's filter — a partial sync is unreadable in history otherwise
        detail: err ? err : `${written} writes → ${t.name} (server)`,
      });

      if (err) return json({ ok: false, error: err, attempted: summary }, 502);
      return json({ ok: true, sent: summary, writes: written,
                    note: 'Sent from the server. The CMS Sync history will show this as a server sync.' });
    }

    const payload = spec.include_meta === false ? body : {
      meta: { generated_at: new Date().toISOString(), profile: profile.name, pack_count: packList.length, question_count: questions.length, levels_expanded: !!spec.expand_levels, filtered_packs: packSlugs.length ? packSlugs : undefined },
      ...(stats ? { stats } : {}),
      ...(Array.isArray(body) ? { data: body } : body),
    };
    if (wantXml) return xmlResp(toXml(payload, 'gameContent'), 200, { 'Cache-Control': 'public, max-age=60' });
    return json(payload, 200, { 'Cache-Control': 'public, max-age=60' });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
