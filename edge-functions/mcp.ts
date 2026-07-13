// mcp — Model Context Protocol server for Positive Minds.
//
// WHAT THIS IS: it lets three trusted partners connect Claude to this CMS and propose content by
// simply talking to it — "write me 15 questions for Calmness about bedtime worries". Claude calls
// the tools below; the questions land in the human review queue.
//
// WHY IT IS SAFE — and this matters more than any permission check I could add:
//   The architecture ALREADY guarantees a partner cannot reach a child. pm_review_approve is the
//   ONLY path into live content, and it requires Albert to press Approve. So the worst thing a
//   partner can do — even a compromised one — is fill the review queue with things Albert rejects.
//   That is the entire blast radius.
//
//   There is deliberately NO tool to publish, delete, or edit a pack. If a partner needs to do more
//   than propose content, they should be in the CMS, not a chat window.
//
// AUTH: a shared-secret token per partner (Authorization: Bearer pmk_...). NOT OAuth — with three
// trusted people, OAuth 2.1 with PKCE would be pure ceremony. The token gives us what we actually
// need: we know WHO proposed each question, and we can revoke one partner without touching others.
// Tokens are stored as sha256 hashes; the raw token is shown once and never recoverable.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Expose-Headers': 'mcp-session-id',
};

// ============================================================
// The engine + validator — MUST mirror core.jsx byte-for-byte (the parity invariant).
// A partner's draft is checked against exactly the same rules as everything else.
// ============================================================
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

function altFitsBlank(blank: string, alt: string): boolean {
  alt = (alt || '').toUpperCase();
  if (alt.length !== blank.length) return false;
  for (let i = 0; i < blank.length; i++) {
    if (blank[i] !== '_' && blank[i] !== alt[i]) return false;
  }
  return true;
}

function validateQuestion(q: any, levels: any[], opts: any = {}) {
  const flags: any[] = [];
  const tpl = q.template || '';
  const ans = (q.answer || '').toUpperCase().trim();
  const alt = (q.alt_answer || '').toUpperCase().trim();

  const blanks = (tpl.match(/\{blank\}/g) || []).length;
  if (blanks === 0) flags.push({ code: 'no_blank', detail: 'Sentence has no {blank} placeholder.' });
  else if (blanks > 1) flags.push({ code: 'multi_blank', detail: `Sentence has ${blanks} {blank} placeholders — must have exactly one.` });

  if (!ans) flags.push({ code: 'no_answer', detail: 'Missing the primary answer word.' });
  if (!alt) flags.push({ code: 'no_alt', detail: 'Missing the alternate word.' });
  if (ans && alt && ans === alt) flags.push({ code: 'same_word', detail: 'The two options are the same word.' });

  if (ans && alt && ans !== alt && blanks === 1) {
    const bad: number[] = [];
    for (const lvl of levels || []) {
      const isWord = lvl.hidden_mode === 'word';
      let blank: string;
      if (isWord) blank = '_'.repeat(Math.max(3, ans.length));
      else {
        const letters = Math.min(lvl.letters_hidden_default || 2, Math.max(1, ans.length - 1));
        blank = maskWord(ans, letters, lvl.letter_position || 'end', lvl.letter_grouping || 'grouped');
      }
      if (altFitsBlank(blank, alt)) bad.push(lvl.level);
    }
    if (bad.length) {
      flags.push({
        code: 'ambiguous', levels: bad,
        detail: `"${alt}" also fits the blank at level${bad.length > 1 ? 's' : ''} ${bad.join(', ')} — two correct answers. The alternate must be a DIFFERENT length from "${ans}".`,
      });
    }
  }

  const lvl = (levels || []).find((l: any) => l.level === opts.targetLevel);
  if (lvl && ans) {
    const letters = ans.replace(/\s+/g, '').length;
    const words = ans.trim().split(/\s+/).filter(Boolean).length;
    if (lvl.min_word_len && letters < lvl.min_word_len) flags.push({ code: 'too_short', level: lvl.level, detail: `"${ans}" is ${letters} letters; level ${lvl.level} wants at least ${lvl.min_word_len}.` });
    if (lvl.max_word_len && letters > lvl.max_word_len) flags.push({ code: 'too_long', level: lvl.level, detail: `"${ans}" is ${letters} letters; level ${lvl.level} allows at most ${lvl.max_word_len}.` });
    if (words > 1 && !lvl.allow_multiword) flags.push({ code: 'multiword', level: lvl.level, detail: `Level ${lvl.level} doesn't allow multi-word answers.` });
  }

  if (ans && /[^A-Z\s'-]/.test(ans)) flags.push({ code: 'bad_chars', detail: `"${ans}" contains characters other than letters.` });
  if (alt && /[^A-Z\s'-]/.test(alt)) flags.push({ code: 'bad_chars_alt', detail: `"${alt}" contains characters other than letters.` });

  const norm = (s: string) => (s || '').toLowerCase().replace(/\{blank\}/g, '___').replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

  if (ans) {
    const tplN = norm(tpl);
    let exact = false, sameSentence = false, reusedIn: any = null;
    for (const e of opts.existing || []) {
      const eAns = (e.answer || '').toUpperCase();
      const eTpl = norm(e.template);
      if (eTpl === tplN && eAns === ans) { exact = true; break; }
      if (eTpl === tplN) sameSentence = true;
      if (eAns === ans && !reusedIn) reusedIn = e;
    }
    if (exact) {
      flags.push({ code: 'duplicate', detail: 'This exact question already exists.' });
    } else {
      if (sameSentence) flags.push({ code: 'same_sentence', detail: 'This sentence is already used with a different answer.' });
      if (reusedIn) {
        const where = reusedIn.source === 'pending' ? 'is already waiting in the review queue'
          : reusedIn.source === 'rejected' ? 'was already rejected'
          : reusedIn.source === 'batch' ? 'is used by another question in this same batch'
          : 'is already used in this pack';
        flags.push({ code: 'answer_reused', detail: `The answer "${ans}" ${where}${reusedIn.template ? ` — "${String(reusedIn.template).replace(/\{blank\}/g, '____')}"` : ''}.` });
      }
    }
  }

  if (ans && alt) {
    const pairKey = [ans, alt].sort().join('|');
    const twin = (opts.existing || []).find((e: any) => {
      const ea = (e.answer || '').toUpperCase(), eb = (e.alt_answer || '').toUpperCase();
      if (!ea || !eb) return false;
      return [ea, eb].sort().join('|') === pairKey && !(ea === ans && eb === alt);
    });
    if (twin) {
      flags.push({
        code: 'reversed_pair',
        detail: `The same two words (${[ans, alt].sort().join(' / ')}) are already the choice in another question — just swapped over. The child would see the identical pair twice.`,
      });
    }
  }

  return { ok: flags.length === 0, flags };
}

// ============================================================
// Auth: verify the partner's token.
// ============================================================
async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function authenticate(db: any, req: Request): Promise<{ partner: string; id: string } | null> {
  const auth = req.headers.get('authorization') || '';
  const raw = auth.replace(/^Bearer\s+/i, '').trim();
  if (!raw.startsWith('pmk_')) return null;

  const hash = await sha256(raw);
  const { data } = await db.from('pm_mcp_tokens')
    .select('id, partner, active').eq('token_hash', hash).eq('active', true).maybeSingle();
  if (!data) return null;

  // Best-effort usage tracking — never let it break the request.
  db.from('pm_mcp_tokens')
    .update({ last_used_at: new Date().toISOString(), calls_made: (data.calls_made ?? 0) + 1 })
    .eq('id', data.id).then(() => {}).catch(() => {});

  return { partner: data.partner, id: data.id };
}

// ============================================================
// THE TOOLS. Four of them. Deliberately narrow.
// ============================================================
const TOOLS = [
  {
    name: 'list_packs',
    description:
      'List the question packs and the difficulty levels. Call this FIRST so you know what exists ' +
      'and what each level requires (word-length bands, whether the whole word is hidden, etc). ' +
      'Every pack is a theme, e.g. Confidence or Calmness.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_pack_content',
    description:
      'Show the questions already in a pack, and every answer word already used. Call this BEFORE ' +
      'writing new questions so you do not repeat a word, a sentence, or a word-pair. Each word ' +
      'should be taught once.',
    inputSchema: {
      type: 'object',
      properties: { pack_slug: { type: 'string', description: 'e.g. "confidence"' } },
      required: ['pack_slug'],
    },
  },
  {
    name: 'check_questions',
    description:
      'Check draft questions against the real game engine WITHOUT saving anything. Use this to catch ' +
      'and fix problems yourself before proposing. It checks the rules a human eye misses — above ' +
      'all whether both words are the same LENGTH, which would give the child two correct answers.',
    inputSchema: {
      type: 'object',
      properties: {
        pack_slug: { type: 'string' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              template: { type: 'string', description: 'The sentence, with exactly one {blank}' },
              answer: { type: 'string', description: 'The CORRECT word, uppercase' },
              alt_answer: { type: 'string', description: 'The wrong word — must be a DIFFERENT LENGTH' },
            },
            required: ['template', 'answer', 'alt_answer'],
          },
        },
      },
      required: ['pack_slug', 'questions'],
    },
  },
  {
    name: 'propose_questions',
    description:
      'Send questions to the human review queue. They do NOT go live — a person reads every one and ' +
      'approves, edits or rejects it. Run check_questions first and fix anything flagged.',
    inputSchema: {
      type: 'object',
      properties: {
        pack_slug: { type: 'string' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              template: { type: 'string' },
              answer: { type: 'string' },
              alt_answer: { type: 'string' },
            },
            required: ['template', 'answer', 'alt_answer'],
          },
        },
      },
      required: ['pack_slug', 'questions'],
    },
  },
];

// The brief Claude needs to write good content. Returned by list_packs so it is always in context.
const BRIEF = `THE GAME — read this, or nothing else makes sense.

It is a SPELLING puzzle, not a comprehension one. A short first-person sentence appears with one
word partly hidden:

    I feel PR_UD when I try.        →  the child picks between  PROUD  /  CALM

The child picks the word whose SPELLING fits the revealed letters and the blank shape.

TWO RULES THAT ARE NOT NEGOTIABLE:

1. BOTH words are ALWAYS positive. Never show a child a negative word about themselves. This is
   therapy content (CBMT) for children aged about 5-12. "KIND / MEAN" is forbidden — MEAN must
   never appear.

2. THE TWO WORDS MUST BE DIFFERENT LENGTHS. At the higher levels the WHOLE word is hidden, so the
   only clue is its LENGTH. If both words are the same length, BOTH fit the blank — the child has
   two correct answers, picks a perfectly good word, and is told they are WRONG.
       BROKEN:  BRIGHT (6) / GENTLE (6)   — both fit "______"
       GOOD:    PROUD  (5) / CALM   (4)   — only one fits

   This is the single most important rule. It has broken real content before.

ALSO: warm, simple, first-person sentences ("I am...", "I feel..."). Each answer word taught once
per pack. Don't reuse a word-pair, even swapped over. Don't reuse the same wrong option repeatedly —
a predictable distractor teaches the child "it's never that one" instead of reading the blank.`;

// ============================================================
async function callTool(db: any, partner: string, name: string, args: any) {
  // ---- list_packs ----
  if (name === 'list_packs') {
    const { data: packs } = await db.from('pm_packs')
      .select('slug,name,emoji,description,level,status')
      .eq('status', 'published').order('name').limit(200);
    const { data: levels } = await db.from('pm_levels').select('*').order('level').limit(200);

    return {
      brief: BRIEF,
      packs: (packs || []).map((p: any) => ({
        slug: p.slug, name: p.name, emoji: p.emoji,
        description: p.description, default_level: p.level,
      })),
      levels: (levels || []).map((l: any) => ({
        level: l.level, name: l.name,
        what_is_hidden: l.hidden_mode === 'word' ? 'the WHOLE word (only length is a clue)' : `${l.letters_hidden_default ?? 2} letter(s)`,
        age_hint: l.age_hint,
        word_length: l.min_word_len || l.max_word_len
          ? `${l.min_word_len ?? '?'}–${l.max_word_len ?? '?'} letters`
          : 'no restriction',
      })),
    };
  }

  // ---- get_pack_content ----
  if (name === 'get_pack_content') {
    const { data: pack } = await db.from('pm_packs')
      .select('id,slug,name,description,level,purpose,focus_areas')
      .eq('slug', args.pack_slug).maybeSingle();
    if (!pack) return { error: `No pack with slug "${args.pack_slug}". Call list_packs to see what exists.` };

    const { data: qs } = await db.from('pm_questions')
      .select('template,answer,alt_answer')
      .eq('pack_id', pack.id).eq('status', 'active').limit(1000);

    const { data: queued } = await db.from('pm_review_queue')
      .select('answer,alt_answer,status')
      .eq('pack_id', pack.id).in('status', ['pending', 'rejected']).limit(1000);

    const usedWords = [...new Set([
      ...(qs || []).map((q: any) => (q.answer || '').toUpperCase()),
      ...(queued || []).map((q: any) => (q.answer || '').toUpperCase()),
    ].filter(Boolean))];

    const rejectedWords = [...new Set((queued || [])
      .filter((q: any) => q.status === 'rejected')
      .map((q: any) => (q.answer || '').toUpperCase()).filter(Boolean))];

    return {
      pack: { slug: pack.slug, name: pack.name, description: pack.description, default_level: pack.level, purpose: pack.purpose, focus_areas: pack.focus_areas },
      existing_questions: (qs || []).map((q: any) => ({
        sentence: (q.template || '').replace(/\{blank\}/g, '____'),
        answer: q.answer, alternate: q.alt_answer,
      })),
      answer_words_already_taken: usedWords,
      previously_rejected: rejectedWords,
      note: 'Do not reuse any word in answer_words_already_taken. Each word should be taught once.',
    };
  }

  // ---- check_questions / propose_questions (they share the validation) ----
  if (name === 'check_questions' || name === 'propose_questions') {
    const { data: pack } = await db.from('pm_packs')
      .select('id,slug,name,level').eq('slug', args.pack_slug).maybeSingle();
    if (!pack) return { error: `No pack with slug "${args.pack_slug}".` };

    const list = Array.isArray(args.questions) ? args.questions : [];
    if (!list.length) return { error: 'No questions given.' };
    if (list.length > 30) return { error: 'Too many at once — 30 maximum per call.' };

    const { data: levels } = await db.from('pm_levels').select('*').order('level').limit(200);
    const { data: liveQs } = await db.from('pm_questions')
      .select('template,answer,alt_answer').eq('pack_id', pack.id).limit(2000);
    const { data: queuedQs } = await db.from('pm_review_queue')
      .select('template,answer,alt_answer,status')
      .eq('pack_id', pack.id).in('status', ['pending', 'rejected']).limit(2000);

    const existing = [
      ...(liveQs || []).map((q: any) => ({ ...q, source: 'live' })),
      ...(queuedQs || []).map((q: any) => ({ ...q, source: q.status })),
    ];

    // Validate cumulatively, so a word repeated WITHIN this batch is caught too.
    const seen = [...existing];
    const checked = list.map((q: any) => {
      const result = validateQuestion(q, levels || [], { targetLevel: pack.level ?? 1, existing: seen });
      seen.push({ template: q.template, answer: q.answer, alt_answer: q.alt_answer, source: 'batch' });
      return { q, result };
    });

    const clean = checked.filter(c => c.result.ok);
    const flagged = checked.filter(c => !c.result.ok);

    // check_questions: report only. Nothing is saved.
    if (name === 'check_questions') {
      return {
        checked: checked.length,
        passed: clean.length,
        problems: flagged.map(c => ({
          question: `"${c.q.template}" — ${c.q.answer} / ${c.q.alt_answer}`,
          problems: c.result.flags.map((f: any) => f.detail),
        })),
        note: flagged.length
          ? 'Fix these and check again before proposing.'
          : 'All good — you can propose these.',
      };
    }

    // propose_questions: write to the REVIEW QUEUE. Never to a pack.
    const { data: res, error } = await db.rpc('pm_review_enqueue', {
      p_pack_id: pack.id,
      p_items: checked.map(c => ({
        template: c.q.template,
        answer: c.q.answer,
        alt_answer: c.q.alt_answer,
        validation: c.result,
      })),
      p_source: `partner:${partner}`,     // so Albert knows whose work he is reviewing
      p_target_level: pack.level ?? null,
    });
    if (error) return { error: String(error.message || error) };

    return {
      sent_for_review: res?.queued ?? checked.length,
      passed_every_check: clean.length,
      flagged: flagged.length,
      problems: flagged.map(c => ({
        question: `"${c.q.template}" — ${c.q.answer} / ${c.q.alt_answer}`,
        problems: c.result.flags.map((f: any) => f.detail),
      })),
      note: 'These are now waiting for a human to approve, edit or reject. Nothing is live yet.',
    };
  }

  return { error: `Unknown tool: ${name}` };
}

// ============================================================
// MCP protocol (JSON-RPC 2.0 over Streamable HTTP)
// ============================================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

  if (req.method !== 'POST') {
    return json({ error: 'This is an MCP endpoint. POST JSON-RPC.' }, 405);
  }

  let body: any;
  try { body = await req.json(); }
  catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }

  const { id, method, params } = body || {};
  const rpcErr = (code: number, message: string) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const rpcOk = (result: unknown) => json({ jsonrpc: '2.0', id: id ?? null, result });

  // initialize + notifications need no auth (the handshake happens before the token is used)
  if (method === 'initialize') {
    return rpcOk({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'positive-minds', version: '1.0.0' },
      instructions:
        'Write therapeutic word-puzzle content for children. ALWAYS call list_packs first (it ' +
        'returns the brief), then get_pack_content for the pack you are writing for, then ' +
        'check_questions on your drafts, and only then propose_questions. Nothing you propose goes ' +
        'live — a human reviews every question.',
    });
  }
  if (method === 'notifications/initialized') return new Response(null, { status: 202, headers: cors });

  // Everything else needs a valid partner token.
  const who = await authenticate(db, req);
  if (!who) {
    return json(
      { jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message: 'Unauthorized — a valid partner token is required.' } },
      401,
      );
  }

  if (method === 'tools/list') {
    return rpcOk({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const out = await callTool(db, who.partner, name, args);
      return rpcOk({
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        isError: !!(out as any)?.error,
      });
    } catch (e) {
      return rpcOk({
        content: [{ type: 'text', text: `Something went wrong: ${String(e).slice(0, 300)}` }],
        isError: true,
      });
    }
  }

  return rpcErr(-32601, `Method not found: ${method}`);
});
