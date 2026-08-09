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
// AUTH: OAuth 2.1 with PKCE. This is NOT optional — Claude's "Add custom connector" screen offers a
// URL and an OAuth client ID/secret, and NOTHING else. There is no field to paste a bearer token, so
// a shared-secret header simply could not be used: Claude would never send it. The MCP spec is
// unambiguous — a protected server does OAuth 2.1, or it is authless.
//
// We are therefore a (small) authorization server as well as a resource server. Because the partners
// are three trusted people, the consent screen is just "paste the token Albert sent you" — their
// pmk_ token becomes the LOGIN CREDENTIAL rather than a request header. From their side it is simply:
// click Connect → a page appears → paste → done.
//
// Endpoints Claude requires:
//   GET  /.well-known/oauth-protected-resource   "here is my authorization server"   (RFC 9728)
//   GET  /.well-known/oauth-authorization-server "here are my endpoints"             (RFC 8414)
//   POST /register                                Claude registers itself             (RFC 7591)
//   GET  /authorize                               the partner's login screen
//   POST /token                                   code → access token (PKCE verified)
// And a 401 MUST carry WWW-Authenticate pointing at the metadata, or Claude never starts the flow.

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

  // DUPLICATE — the ONE dedup condition (mirror of the client validateQuestion EXACTLY). A question
  // is a duplicate ONLY when an existing question (in this pack) has the SAME sentence AND the SAME
  // right/wrong combination, order-sensitive: same template AND same answer AND same alt_answer.
  // Strict by design (2026-07): reversed pairs, same sentence with a different pair, and reused
  // answer words are all DIFFERENT questions and pass cleanly. `existing` must include live + pending
  // + rejected. Scope is the pack (generation is always pack-level).
  if (ans) {
    const tplN = norm(tpl);
    const isDup = (opts.existing || []).some((e: any) =>
      norm(e.template) === tplN &&
      (e.answer || '').toUpperCase() === ans &&
      (e.alt_answer || '').toUpperCase() === alt
    );
    if (isDup) flags.push({ code: 'duplicate', detail: 'This exact question already exists (same sentence and same right/wrong pair).' });
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

// base64url — PKCE S256 challenges are base64url of the sha256 of the verifier.
function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256b64url(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return b64url(new Uint8Array(buf));
}
function randomToken(prefix: string): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return prefix + b64url(b);
}

// Verify the ACCESS TOKEN Claude sends on every MCP call. Returns which partner it belongs to.
async function authenticate(db: any, req: Request) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const { data: at } = await db.from('pm_oauth_tokens')
    .select('access_token, token_id, expires_at')
    .eq('access_token', token).maybeSingle();
  if (!at) return null;
  if (new Date(at.expires_at) < new Date()) return null;   // expired

  // Which partner? And are they still allowed?
  const { data: partner } = await db.from('pm_mcp_tokens')
    .select('id, partner, active, calls_made').eq('id', at.token_id).maybeSingle();
  if (!partner || !partner.active) return null;            // revoked mid-session

  // Best-effort usage tracking — never let it break the request.
  try {
    await db.from('pm_mcp_tokens')
      .update({ last_used_at: new Date().toISOString(), calls_made: (partner.calls_made ?? 0) + 1 })
      .eq('id', partner.id);
    await db.from('pm_oauth_tokens')
      .update({ last_used_at: new Date().toISOString() }).eq('access_token', token);
  } catch { /* ignore */ }

  return { partner: partner.partner, id: partner.id };
}

// The partner's login screen. Deliberately plain — they paste the token you sent them.
function loginPage(state: string, clientId: string, redirectUri: string, challenge: string, error?: string): string {
  const esc = (x: string) => String(x || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const errBlock = error ? '<div class="err">' + esc(error) + '</div>' : '';
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>Connect to Positive Minds</title>' +
'<style>' +
'*{box-sizing:border-box}' +
'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;' +
'background:#F7F6FB;color:#191728;padding:20px}' +
'.card{background:#fff;border-radius:18px;padding:34px 30px;max-width:420px;width:100%;' +
'box-shadow:0 12px 40px rgba(25,23,40,.10);border:1px solid #E8E6F0}' +
'h1{margin:0 0 6px;font-size:21px;font-weight:800;letter-spacing:-.2px}' +
'p{margin:0 0 20px;color:#6E6B85;font-size:14px;line-height:1.6}' +
'label{display:block;font-size:12px;font-weight:700;color:#4A4763;margin-bottom:6px}' +
'input{width:100%;padding:13px 14px;border:1px solid #E8E6F0;border-radius:10px;font-size:16px;' +
'font-family:ui-monospace,Menlo,monospace;background:#FBFAFE;color:#191728}' +
'input:focus{outline:none;border-color:#6C4CE0;box-shadow:0 0 0 3px rgba(108,76,224,.12)}' +
'button{width:100%;margin-top:16px;padding:13px;border:none;border-radius:10px;background:#6C4CE0;' +
'color:#fff;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit}' +
'button:hover{background:#5B3FCC}' +
'.err{background:#FDECEC;border:1px solid #F3C7C7;color:#C2352F;padding:11px 13px;border-radius:9px;' +
'font-size:13.5px;margin-bottom:16px;line-height:1.5}' +
'.note{margin-top:18px;font-size:12.5px;color:#8B87A3;line-height:1.6}' +
'</style></head><body>' +
'<div class="card">' +
'<h1>Connect to Positive Minds</h1>' +
'<p>Paste the token you were sent. You will then be able to write questions just by asking Claude.</p>' +
errBlock +
'<form method="POST" action="/functions/v1/mcp/authorize">' +
'<input type="hidden" name="state" value="' + esc(state) + '">' +
'<input type="hidden" name="client_id" value="' + esc(clientId) + '">' +
'<input type="hidden" name="redirect_uri" value="' + esc(redirectUri) + '">' +
'<input type="hidden" name="code_challenge" value="' + esc(challenge) + '">' +
'<label for="tk">Your token</label>' +
'<input id="tk" name="token" type="password" placeholder="pmk_..." autocomplete="off" autofocus required>' +
'<button type="submit">Connect</button>' +
'</form>' +
'<div class="note">Anything you write goes to a review queue for approval first — nothing you send goes live on its own.</div>' +
'</div></body></html>';
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
      'Show a pack\'s current statistics and the questions already in it. Call this AFTER the person ' +
      'picks a pack and BEFORE writing, so you can see how full it is and what already exists. Prefer ' +
      'fresh words and sentences for variety; the only hard rule is not to reproduce an exact ' +
      'existing question (same sentence AND same right/wrong pair).',
    inputSchema: {
      type: 'object',
      properties: { pack_slug: { type: 'string', description: 'e.g. "confidence"' } },
      required: ['pack_slug'],
    },
  },
  {
    name: 'check_questions',
    description:
      'Check draft questions against the real game engine AND the pack\'s existing content, WITHOUT ' +
      'saving anything. ALWAYS run this before proposing. It catches the problems a human eye misses — ' +
      'above all whether both words are the same LENGTH (which gives the child two correct answers), ' +
      'and whether a draft exactly duplicates a question already in the pack or the review queue.',
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
  {
    name: 'create_pack',
    description:
      'Create a new themed pack (e.g. "Bravery", "Friendship"). The pack is created and published in ' +
      'the CMS straight away, so you can start proposing questions into it immediately. Only the pack ' +
      'itself is created — its QUESTIONS still go to the human review queue like any other. Ask the ' +
      'person what the pack should be about before calling this, and check list_packs first so you ' +
      'do not duplicate an existing theme.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name, e.g. "Bravery Pack"' },
        description: { type: 'string', description: 'Short blurb shown on the pack card' },
        emoji: { type: 'string', description: 'A single emoji for the pack (default 💪)' },
        level: { type: 'number', description: 'Default level for questions in this pack (default 1)' },
        difficulty: { type: 'string', description: 'basic | intermediate | advanced (default basic)' },
        purpose: { type: 'string', description: 'What this pack is for — its therapeutic objective' },
        focus_areas: { type: 'string', description: 'The themes/situations it should cover' },
        style_approach: { type: 'string', description: 'Tone and style guidance for its questions' },
        example_objectives: { type: 'string', description: 'Example objectives for the pack' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_pack',
    description:
      'Edit an existing pack\'s details — name, description, emoji, level, difficulty, or the pack ' +
      'guidance fields (purpose, focus areas, style, objectives). Use this to sharpen a pack\'s ' +
      'definition. The slug cannot be changed (the game keys on it). Only fields you supply are ' +
      'changed; anything you omit is left alone.',
    inputSchema: {
      type: 'object',
      properties: {
        pack_slug: { type: 'string', description: 'Which pack to edit' },
        name: { type: 'string' },
        description: { type: 'string' },
        emoji: { type: 'string' },
        level: { type: 'number' },
        difficulty: { type: 'string' },
        purpose: { type: 'string' },
        focus_areas: { type: 'string' },
        style_approach: { type: 'string' },
        example_objectives: { type: 'string' },
      },
      required: ['pack_slug'],
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

ALSO: warm, simple, first-person sentences ("I am...", "I feel..."). Fresh words and sentences make a
better, more varied pack, so PREFER variety. But the ONE hard rule about repetition is: never
reproduce an existing question EXACTLY — same sentence AND the same two words (right + wrong). Reusing
a word, or an existing sentence with a different pair, is fine. Try not to lean on the same wrong
option over and over, though — a predictable distractor teaches the child "it's never that one"
instead of reading the blank.`;

// ============================================================
async function callTool(db: any, partner: string, name: string, args: any) {
  // ---- list_packs ----
  if (name === 'list_packs') {
    const { data: packs } = await db.from('pm_packs')
      .select('id,slug,name,emoji,description,level,status')
      .in('status', ['published', 'draft']).order('name').limit(200);
    const { data: levels } = await db.from('pm_levels').select('*').order('level').limit(200);

    // Per-pack statistics, so the contributor can SEE how full each pack is and where the gaps are
    // (rather than guessing). Counted from live questions + what is already waiting in review.
    const packIds = (packs || []).map((p: any) => p.id);
    const { data: allQs } = packIds.length
      ? await db.from('pm_questions').select('pack_id,answer').eq('status', 'active').in('pack_id', packIds).limit(5000)
      : { data: [] };
    const { data: pendingQs } = packIds.length
      ? await db.from('pm_review_queue').select('pack_id').eq('status', 'pending').in('pack_id', packIds).limit(5000)
      : { data: [] };
    const liveCount: Record<string, number> = {};
    const wordSets: Record<string, Set<string>> = {};
    const pendCount: Record<string, number> = {};
    for (const q of allQs || []) {
      liveCount[q.pack_id] = (liveCount[q.pack_id] || 0) + 1;
      (wordSets[q.pack_id] = wordSets[q.pack_id] || new Set()).add((q.answer || '').toUpperCase());
    }
    for (const r of pendingQs || []) pendCount[r.pack_id] = (pendCount[r.pack_id] || 0) + 1;

    return {
      brief: BRIEF,
      how_to_start: 'Show these packs to the person as a numbered list with their stats, and ask which ONE they want to add to. Then call get_pack_content for that pack before writing anything. If none of the existing packs fit what they want to write about, you can offer to make a new one with create_pack.',
      packs: (packs || []).map((p: any) => ({
        slug: p.slug, name: p.name, emoji: p.emoji,
        description: p.description, default_level: p.level, status: p.status,
        stats: {
          live_questions: liveCount[p.id] || 0,
          distinct_answer_words: wordSets[p.id] ? wordSets[p.id].size : 0,
          awaiting_review: pendCount[p.id] || 0,
        },
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

    const pendingCount = (queued || []).filter((q: any) => q.status === 'pending').length;

    return {
      pack: { slug: pack.slug, name: pack.name, description: pack.description, default_level: pack.level, purpose: pack.purpose, focus_areas: pack.focus_areas },
      statistics: {
        live_questions: (qs || []).length,
        distinct_answer_words: usedWords.length,
        awaiting_review: pendingCount,
        previously_rejected: rejectedWords.length,
      },
      existing_questions: (qs || []).map((q: any) => ({
        sentence: (q.template || '').replace(/\{blank\}/g, '____'),
        answer: q.answer, alternate: q.alt_answer,
      })),
      answer_words_already_taken: usedWords,
      previously_rejected: rejectedWords,
      note: 'Fresh words and sentences make a better, more varied pack — so PREFER them. But the only HARD rule is: do not reproduce an existing question exactly (same sentence AND the same right/wrong pair). Reusing a word, or an existing sentence with a different pair, is allowed. Run check_questions to be sure before you propose.',
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

  // ---- create_pack ----
  // Mirrors the CMS PackEditor + savePack convention EXACTLY: same slugify, same defaults,
  // sort_order = count + 1, and an activity-log entry. Difference from the CMS form: status is
  // 'published' rather than 'draft', by explicit decision — the pack container goes live in the CMS
  // immediately so a contributor can write into it, while its QUESTIONS still go to the review queue.
  if (name === 'create_pack') {
    const rawName = String(args.name || '').trim();
    if (!rawName) return { error: 'Give the pack a name.' };

    // Same slugify as core.jsx: lowercase, non-alphanumerics -> '-', trim leading/trailing '-'.
    const slug = rawName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) return { error: `"${rawName}" doesn't produce a usable slug — use some letters or numbers in the name.` };

    const { data: clash } = await db.from('pm_packs').select('slug,name').eq('slug', slug).maybeSingle();
    if (clash) return { error: `A pack with the slug "${slug}" already exists ("${clash.name}"). Pick a different name, or use update_pack to edit that one.` };

    // Validate the level against the real level list, like the CMS's level picker does.
    const { data: levels } = await db.from('pm_levels').select('level').order('level').limit(200);
    const validLevels = (levels || []).map((l: any) => l.level);
    const level = args.level != null ? Number(args.level) : 1;
    if (validLevels.length && !validLevels.includes(level)) {
      return { error: `Level ${level} doesn't exist. Available levels: ${validLevels.join(', ')}.` };
    }

    const difficulty = ['basic', 'intermediate', 'advanced'].includes(String(args.difficulty || '').toLowerCase())
      ? String(args.difficulty).toLowerCase() : 'basic';

    const { count } = await db.from('pm_packs').select('id', { count: 'exact', head: true });

    const { data: created, error: cErr } = await db.from('pm_packs').insert({
      slug,
      name: rawName,
      emoji: args.emoji || '💪',
      description: args.description || '',
      difficulty,
      status: 'published',           // published in the CMS immediately (decision, 2026-08)
      level,
      is_custom: true,               // created outside the CMS form
      sort_order: (count ?? 0) + 1,
      purpose: args.purpose || '',
      focus_areas: args.focus_areas || '',
      style_approach: args.style_approach || '',
      example_objectives: args.example_objectives || '',
    }).select('id,slug,name,emoji,level,difficulty,status').maybeSingle();
    if (cErr) return { error: String(cErr.message || cErr) };

    // Match the CMS: every pack create is recorded in the activity log, attributed to the partner.
    try {
      await db.from('pm_activity').insert({
        entity: 'pack', entity_id: created?.id, entity_name: rawName,
        action: 'create', actor: `partner:${partner}`, detail: 'created via Claude connector',
      });
    } catch { /* logging must never break the call */ }

    return {
      created: created,
      note: `Pack "${rawName}" is created and published in the CMS (slug: ${slug}). You can propose questions into it now — they will still go to the human review queue for approval.`,
    };
  }

  // ---- update_pack ----
  // Only the fields supplied are changed. The slug is deliberately NOT editable: the game and
  // get_pack_content key on it.
  if (name === 'update_pack') {
    const { data: pack } = await db.from('pm_packs')
      .select('id,slug,name,level').eq('slug', args.pack_slug).maybeSingle();
    if (!pack) return { error: `No pack with slug "${args.pack_slug}". Call list_packs to see what exists.` };

    const patch: Record<string, unknown> = {};
    if (args.name != null && String(args.name).trim()) patch.name = String(args.name).trim();
    if (args.description != null) patch.description = args.description;
    if (args.emoji != null) patch.emoji = args.emoji;
    if (args.purpose != null) patch.purpose = args.purpose;
    if (args.focus_areas != null) patch.focus_areas = args.focus_areas;
    if (args.style_approach != null) patch.style_approach = args.style_approach;
    if (args.example_objectives != null) patch.example_objectives = args.example_objectives;

    if (args.difficulty != null) {
      const d = String(args.difficulty).toLowerCase();
      if (!['basic', 'intermediate', 'advanced'].includes(d)) return { error: 'difficulty must be basic, intermediate or advanced.' };
      patch.difficulty = d;
    }

    let levelWarning: string | null = null;
    if (args.level != null) {
      const { data: levels } = await db.from('pm_levels').select('level').order('level').limit(200);
      const validLevels = (levels || []).map((l: any) => l.level);
      const lv = Number(args.level);
      if (validLevels.length && !validLevels.includes(lv)) {
        return { error: `Level ${lv} doesn't exist. Available levels: ${validLevels.join(', ')}.` };
      }
      patch.level = lv;
      if (lv !== pack.level) {
        const { count: qCount } = await db.from('pm_questions')
          .select('id', { count: 'exact', head: true }).eq('pack_id', pack.id).eq('status', 'active');
        if ((qCount ?? 0) > 0) {
          levelWarning = `Heads up: this pack already has ${qCount} question(s) written for level ${pack.level}. ` +
            `Changing the default level to ${lv} does not rewrite them, and some may not fit the new level's word-length rules.`;
        }
      }
    }

    if (!Object.keys(patch).length) return { error: 'Nothing to update — supply at least one field to change.' };
    patch.updated_at = new Date().toISOString();

    const { data: updated, error: uErr } = await db.from('pm_packs')
      .update(patch).eq('id', pack.id)
      .select('id,slug,name,emoji,level,difficulty,status').maybeSingle();
    if (uErr) return { error: String(uErr.message || uErr) };

    try {
      await db.from('pm_activity').insert({
        entity: 'pack', entity_id: pack.id, entity_name: updated?.name || pack.name,
        action: 'update', actor: `partner:${partner}`,
        detail: `updated via Claude connector (${Object.keys(patch).filter(k => k !== 'updated_at').join(', ')})`,
      });
    } catch { /* ignore */ }

    return {
      updated,
      changed_fields: Object.keys(patch).filter(k => k !== 'updated_at'),
      warning: levelWarning,
      note: 'Pack details updated. The slug is unchanged — the game keys on it.',
    };
  }

  return { error: `Unknown tool: ${name}` };
}

// ============================================================
// ROUTING: the OAuth endpoints, then the MCP endpoint itself.
// ============================================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  const url = new URL(req.url);
  const path = url.pathname;

  // BUILD THE PUBLIC BASE URL CORRECTLY. Two bugs live here if you don't:
  //   1. Supabase terminates TLS at the edge, so url.origin sees plain HTTP. Advertising an http://
  //      OAuth endpoint makes Claude reject the server outright — an insecure authorization server is
  //      not acceptable.
  //   2. The function is served at /functions/v1/mcp, NOT /mcp. Advertising /mcp/authorize sends
  //      Claude to a URL that does not exist.
  //   3. The `host` header inside the container is Supabase's INTERNAL one
  //      (edge-runtime.supabase.com), not the project's public domain. Deriving the base from the
  //      request would send Claude to the wrong server entirely. SUPABASE_URL is the authoritative
  //      public origin — use that.
  const BASE = `${SUPABASE_URL}/functions/v1/mcp`;

  const json = (b: unknown, s = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json', ...extra } });

  // ---------- 1. Protected Resource Metadata (RFC 9728) ----------
  // "I am a protected resource; here is who issues tokens for me."
  if (path.endsWith('/.well-known/oauth-protected-resource')) {
    return json({
      resource: BASE,
      authorization_servers: [BASE],
      scopes_supported: ['mcp:tools'],
      bearer_methods_supported: ['header'],
    });
  }

  // ---------- 2. Authorization Server Metadata (RFC 8414) ----------
  // "Here are my endpoints." Claude looks for this at the MCP server's own domain.
  if (path.endsWith('/.well-known/oauth-authorization-server')) {
    return json({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],   // OAuth 2.1 requires PKCE
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp:tools'],
    });
  }

  // ---------- 3. Dynamic Client Registration (RFC 7591) ----------
  // Claude registers itself, so nobody has to copy a client ID around.
  if (path.endsWith('/register') && req.method === 'POST') {
    let reg: any = {};
    try { reg = await req.json(); } catch { /* tolerate empty */ }

    const redirectUris: string[] = Array.isArray(reg.redirect_uris) ? reg.redirect_uris : [];
    if (!redirectUris.length) {
      return json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' }, 400);
    }

    const clientId = randomToken('cli_');
    await db.from('pm_oauth_clients').insert({
      client_id: clientId,
      client_name: reg.client_name || 'MCP client',
      redirect_uris: redirectUris,
    });

    return json({
      client_id: clientId,
      client_name: reg.client_name || 'MCP client',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',   // public client — PKCE is what protects it
    }, 201);
  }

  // ---------- 4a. Authorize (GET) — show the partner the login screen ----------
  if (path.endsWith('/authorize') && req.method === 'GET') {
    const clientId = url.searchParams.get('client_id') || '';
    const redirectUri = url.searchParams.get('redirect_uri') || '';
    const state = url.searchParams.get('state') || '';
    const challenge = url.searchParams.get('code_challenge') || '';
    const method = url.searchParams.get('code_challenge_method') || '';

    if (!clientId || !redirectUri) {
      return new Response('Missing client_id or redirect_uri', { status: 400, headers: cors });
    }
    // OAuth 2.1: PKCE is mandatory, and S256 only (plain is forbidden).
    if (!challenge || method !== 'S256') {
      return new Response('PKCE with S256 is required', { status: 400, headers: cors });
    }

    // The redirect_uri must be one this client actually registered — otherwise an attacker could
    // point the code at a URL they control.
    const { data: client } = await db.from('pm_oauth_clients')
      .select('client_id, redirect_uris').eq('client_id', clientId).maybeSingle();
    if (!client || !(client.redirect_uris || []).includes(redirectUri)) {
      return new Response('Unknown client, or redirect_uri was not registered.', { status: 400, headers: cors });
    }

    return new Response(loginPage(state, clientId, redirectUri, challenge), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // ---------- 4b. Authorize (POST) — the partner pasted their token ----------
  if (path.endsWith('/authorize') && req.method === 'POST') {
    const form = await req.formData();
    const raw = String(form.get('token') || '').trim();
    const clientId = String(form.get('client_id') || '');
    const redirectUri = String(form.get('redirect_uri') || '');
    const state = String(form.get('state') || '');
    const challenge = String(form.get('code_challenge') || '');

    const reject = (msg: string) =>
      new Response(loginPage(state, clientId, redirectUri, challenge, msg), {
        status: 200, headers: { ...cors, 'Content-Type': 'text/html; charset=utf-8' },
      });

    if (!raw.startsWith('pmk_')) return reject("That doesn't look like a Positive Minds token. It should start with pmk_.");

    const hash = await sha256(raw);
    const { data: partner } = await db.from('pm_mcp_tokens')
      .select('id, partner, active').eq('token_hash', hash).eq('active', true).maybeSingle();
    if (!partner) return reject('That token was not recognised, or access has been revoked. Ask Albert for a new one.');

    // Re-verify the redirect_uri (do not trust the form).
    const { data: client } = await db.from('pm_oauth_clients')
      .select('redirect_uris').eq('client_id', clientId).maybeSingle();
    if (!client || !(client.redirect_uris || []).includes(redirectUri)) {
      return new Response('Bad redirect_uri.', { status: 400, headers: cors });
    }

    // Issue a short-lived, single-use, PKCE-bound authorization code.
    const code = randomToken('cod_');
    await db.from('pm_oauth_codes').insert({
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      token_id: partner.id,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),   // 10 minutes
    });

    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    if (state) back.searchParams.set('state', state);
    return Response.redirect(back.toString(), 302);
  }

  // ---------- 5. Token — exchange the code for an access token ----------
  if (path.endsWith('/token') && req.method === 'POST') {
    let params: URLSearchParams;
    const ct = req.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const b = await req.json();
      params = new URLSearchParams(Object.entries(b).map(([k, v]) => [k, String(v)]));
    } else {
      params = new URLSearchParams(await req.text());
    }

    const grant = params.get('grant_type');
    if (grant !== 'authorization_code') {
      return json({ error: 'unsupported_grant_type' }, 400);
    }

    const code = params.get('code') || '';
    const verifier = params.get('code_verifier') || '';
    const redirectUri = params.get('redirect_uri') || '';

    const { data: row } = await db.from('pm_oauth_codes')
      .select('*').eq('code', code).maybeSingle();
    if (!row) return json({ error: 'invalid_grant', error_description: 'Unknown code' }, 400);
    if (row.used) return json({ error: 'invalid_grant', error_description: 'Code already used' }, 400);
    if (new Date(row.expires_at) < new Date()) return json({ error: 'invalid_grant', error_description: 'Code expired' }, 400);
    if (row.redirect_uri !== redirectUri) return json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400);

    // PKCE: the verifier must hash to the challenge we stored at /authorize.
    if (!verifier) return json({ error: 'invalid_request', error_description: 'code_verifier required' }, 400);
    const computed = await sha256b64url(verifier);
    if (computed !== row.code_challenge) {
      return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
    }

    // Burn the code — single use, so a replay fails.
    await db.from('pm_oauth_codes').update({ used: true }).eq('code', code);

    const accessToken = randomToken('at_');
    const expiresIn = 60 * 60 * 24 * 30;   // 30 days
    await db.from('pm_oauth_tokens').insert({
      access_token: accessToken,
      token_id: row.token_id,
      client_id: row.client_id,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    });

    return json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: 'mcp:tools',
    });
  }

  // ---------- The MCP endpoint itself ----------
  if (req.method !== 'POST') {
    return json({ error: 'This is an MCP endpoint. POST JSON-RPC.' }, 405);
  }

  let body: any;
  try { body = await req.json(); }
  catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }

  const { id, method, params } = body || {};
  const rpcErr = (code: number, message: string) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  const rpcOk = (result: unknown) => json({ jsonrpc: '2.0', id: id ?? null, result });

  // initialize + notifications need no auth (the handshake precedes the token).
  if (method === 'initialize') {
    return rpcOk({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'positive-minds', version: '1.0.0' },
      instructions:
        'Write therapeutic word-puzzle content for children. ALWAYS call list_packs first (it ' +
        'returns the brief), then get_pack_content for the pack you are writing for, then ' +
        'check_questions on your drafts, and only then propose_questions. Nothing you propose goes ' +
        'live — a human reviews every question. You can also create a new pack (create_pack) or edit ' +
        'a pack\'s details (update_pack) when the person wants a theme that does not exist yet; the ' +
        'pack itself is created immediately, but its questions still go to the review queue.',
    });
  }
  if (method === 'notifications/initialized') return new Response(null, { status: 202, headers: cors });

  // Everything else needs a valid OAuth access token.
  const who = await authenticate(db, req);
  if (!who) {
    // CRITICAL: the WWW-Authenticate header is how Claude discovers it needs to run the OAuth flow.
    // Without it, the connector just fails and never offers to sign in.
    return json(
      { jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message: 'Unauthorized' } },
      401,
      { 'WWW-Authenticate': `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"` },
    );
  }

  if (method === 'tools/list') return rpcOk({ tools: TOOLS });

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
