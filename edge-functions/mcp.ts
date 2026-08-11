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
//   Partners CAN create a pack (create_pack) and edit a pack's details (update_pack) — a decision
//   taken in Aug 2026 so a contributor can set up a new theme and write into it without waiting.
//   That does not weaken the guarantee above: a pack is only a container. Its QUESTIONS still go
//   solely to the review queue, so a new pack is simply empty until Albert approves content into it.
//   There is still deliberately NO tool to DELETE a pack, and none to approve or publish a question.
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
// TOKEN LIFETIMES — effectively indefinite, deliberately.
//
// WHY NOT A SHORT ACCESS TOKEN, which is the usual advice: the claude.ai proxy NEVER REFRESHES.
// Documented and open as anthropics/claude-ai-mcp#228 (plus #155, #188, #207) — the proxy
// reconnects its transport, reports success, and never calls /token or /authorize again. Our own
// logs agree exactly: one /token hit at connect, zero refresh grants, ever.
// So a short expiry is not a security boundary here. It is a SCHEDULED OUTAGE — the day it lapses
// the connector dies and nobody remembers why. A 1-hour token would break this connector daily,
// which is precisely what everyone in those issue threads is suffering.
//
// WHAT ACTUALLY PROTECTS US IS REVOCATION, NOT EXPIRY. authenticate() re-reads
// pm_mcp_tokens.active on EVERY request, so setting active=false kills every session for that
// partner on their very next call — mid-session, no waiting for a token to lapse. That control is
// immediate and total, which is more than a 30-day expiry ever gave us.
//
// THE RESIDUAL RISK, stated plainly: a leaked access token stays valid until someone revokes the
// partner token. That was already true for 30 days; this makes it true indefinitely. The mitigation
// is revocation plus pm_connector_log, which records every use. If a token is ever suspected, run
//     update pm_mcp_tokens set active = false where partner = '<name>';
// and it stops working immediately.
//
// Ten years rather than a null expiry: the auth path checks expires_at unconditionally, and adding
// a null branch to the hot path of authentication is a new way to get authentication wrong.
const ACCESS_TTL  = 60 * 60 * 24 * 365 * 10;  // ~10 years, i.e. indefinite in practice
const REFRESH_TTL = 60 * 60 * 24 * 365 * 10;  // kept in step; the proxy never uses it anyway

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
    .select('id, partner, active, calls_made, can_approve').eq('id', at.token_id).maybeSingle();
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

// How many questions a single preview returns. Named so the true total can be reported alongside
// it, rather than the capped length being mistaken for the whole set.
const PREVIEW_CAP = 40;

// ============================================================
// THE TOOLS. Ten of them. Deliberately narrow: read, propose, preview, and pre-approval fixes only.
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
      'and whether a draft duplicates or closely resembles anything already in the database — the whole ' +
      'database, not just this pack, and including the review queue. An identical sentence blocks; a ' +
      'reworded one or a reused word pair is reported so the writer can choose.',
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
  {
    name: 'review_status',
    description:
      'See the state of ALL question submissions from every contributor: what is still waiting for ' +
      'the reviewer, what was approved, and what was rejected (with the reviewer\'s reasons). All ' +
      'partners share the same full visibility. Use this when the person asks about progress or what ' +
      'is pending, and BEFORE writing more for a pack — the rejection reasons show where the bar is. ' +
      'This returns COUNTS and decisions, not the questions themselves. If the person wants to SEE or ' +
      'go through the actual pending questions, use preview_questions instead.',
    inputSchema: {
      type: 'object',
      properties: {
        pack_slug: { type: 'string', description: 'Optional — limit the report to one pack.' },
      },
    },
  },
  {
    name: 'preview_questions',
    description:
      'Render questions EXACTLY as a child sees them in the game — the sentence with the masked word ' +
      'in place, at each level, with the two options. USE THIS whenever the person wants to SEE or ' +
      'PLAY questions rather than read counts. Trigger phrasings include: "preview", "let\'s preview ' +
      'these", "review the pending questions", "go through the queue", "show me what\'s waiting", ' +
      '"what needs reviewing", "play this", "let me try it", "play the question bank", "show me the ' +
      'questions in <pack>", "how would this look in the game", "what does the child see". Treat any ' +
      'similar phrasing the same way — the intent is always: show the actual questions, playable.\n' +
      'DO NOT call list_packs for this. That returns LEVEL RULES (how many letters are hidden, word ' +
      'lengths) — useful when writing, but showing level rules to someone who asked to see the ' +
      'QUESTIONS is the wrong answer. Come straight here.\n' +
      'WHICH QUESTIONS: pass `questions` to preview drafts you have just written. Otherwise set ' +
      '`source` — "pending" (default) shows what is AWAITING REVIEW, "live" plays a pack\'s ' +
      'already-approved bank. `pack_slug` narrows either to one pack, and is required for "live".\n' +
      'WHAT COMES BACK: `previews` is a list of QUESTIONS. Each has `sentence` (already masked and ' +
      'ready to display), `options` (the two words), `correct`, `level_shown`, and `at_other_levels` ' +
      'if you want level tabs. By default only ONE level is rendered — pass `levels` for more.\n' +
      'THEN RENDER IT AS A PLAYABLE CARD: build an interactive artifact with ONE CARD PER QUESTION, in ' +
      'the order given. Each card shows THAT question\'s `sentence` verbatim and its two `options` as ' +
      'big tappable buttons that turn green (correct) or red (wrong) when tapped. Never reveal which ' +
      'word is correct before it is tapped, and never reword or reorder anything.\n' +
      'DO NOT produce a summary of the levels, a table of level rules, or one section per level. The ' +
      'unit is the QUESTION — if there are twelve questions the person should see twelve cards.\n' +
      'USE THESE EXACT WORDS WHEN A WORD IS TAPPED. Do not improvise them — the tone is decided ' +
      'content, not a detail, and this card is how someone feels what a child feels:\n' +
      '  correct → "Correct answer — you got it right! 😊"\n' +
      '  wrong   → "Nearly right — you\'re getting better every time you try 🙂 Try again…"\n' +
      'NEVER say "wrong", "incorrect" or "that is what the child should pick". A child using this ' +
      'game is never told they failed, and a reviewer playing it should meet the same tone.\n' +
      'Under a wrong answer ONLY, add a small quiet line for the reviewer: "Reviewer check: if this ' +
      'word ALSO fits the blank, the question is broken." That is the check that catches two-correct- ' +
      'answer questions, so keep it — but visually secondary, and never in the child-facing verdict.\n' +
      'MATCH THE CMS DESIGN (Positive Minds house style) so it feels like part of the product:\n' +
      '  page background #F6F5FB; each question in a white #FFFFFF card, 1px #E4E0F0 border, 16px ' +
      'radius, generous padding, soft shadow 0 2px 10px rgba(25,23,40,.05).\n' +
      '  type: system sans (-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui); main text ' +
      '#191728, secondary #6E6B85; small labels UPPERCASE, 11px, weight 800, letter-spacing .3px.\n' +
      '  brand purple #6C4CE0 — selected level tab (white text on purple), the masked blank, and ' +
      'accents; unselected tabs #FBFAFE with #E4E0F0 border and #4A4763 text; pill chips use ' +
      '#EEE9FD background with #4A32B0 text.\n' +
      '  the two words: monospace, weight 800, letter-spacing 1px, 12px radius, 2px border. Correct ' +
      'when tapped = background #DEF5F1, border #0E8C7E, text #0A6B60. Wrong = background #FDECEC, ' +
      'border #C2352F, text #C2352F. Untapped = white with #E4E0F0 border.\n' +
      '  keep it calm and uncluttered — this is children\'s therapy content, not a dashboard.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: 'Drafts to preview. Omit to preview saved questions instead (see `source`).',
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
        source: {
          type: 'string',
          enum: ['pending', 'live'],
          description: '"pending" (default) = awaiting review. "live" = a pack\'s approved question bank (needs pack_slug).',
        },
        pack_slug: { type: 'string', description: 'Limit to one pack. Required when source is "live".' },
        levels: { type: 'array', items: { type: 'number' }, description: 'Only these levels (default: all).' },
      },
    },
  },
  {
    name: 'approve_question',
    description:
      'Approve ONE question from the review queue and make it LIVE. This is the last gate before a ' +
      'child sees it, so treat it as one: PREVIEW THE QUESTION FIRST with preview_questions and ' +
      'actually play it — a same-length pair or a wrong option that also fits the sentence is ' +
      'invisible in a list and only shows when you try it. There is deliberately no bulk approve. ' +
      'You must pass confirm_answer (the correct word, exactly as shown on the card); this exists so ' +
      'a question cannot be approved off a list without being looked at. Only available to tokens ' +
      'granted approval rights.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The review-queue id, from preview_questions.' },
        confirm_answer: { type: 'string', description: 'The CORRECT word for this question, as shown on the card.' },
      },
      required: ['id', 'confirm_answer'],
      additionalProperties: false,
    },
    annotations: { title: 'Approve one question' },
  },
  {
    name: 'unapprove_question',
    description:
      'Undo an approval: takes a live question out of the game and returns it to the review queue. ' +
      'Use it the moment an approval looks wrong — it only ever REMOVES content from children, so it ' +
      'is safe. The question is set inactive rather than deleted, so nothing is lost and the CMS can ' +
      'restore it. Pass the LIVE question id that approve_question returned.',
    inputSchema: {
      type: 'object',
      properties: {
        question_id: { type: 'string', description: 'The live question id returned by approve_question.' },
        reason: { type: 'string', description: 'Optional note recorded on the queue row.' },
      },
      required: ['question_id'],
      additionalProperties: false,
    },
    annotations: { title: 'Undo an approval' },
  },
  {
    name: 'reject_questions',
    description:
      'Reject questions that are waiting in the review queue, with a reason. Rejecting only REMOVES ' +
      'something from the pipeline — it can never put content in front of a child — so it is safe to ' +
      'do from here. Get the ids from preview_questions. (Approving is a separate tool and is only ' +
      'available to tokens that have been granted it.)',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Review-queue ids to reject.' },
        reason: { type: 'string', description: 'Why — this is shown to whoever wrote it, so be specific and kind.' },
      },
      required: ['ids', 'reason'],
    },
  },
  {
    name: 'edit_queued_question',
    description:
      'Fix a question that is still waiting in the review queue — change the sentence, the correct ' +
      'word, or the wrong word. The edit is re-checked against the real game engine and is REJECTED ' +
      'if it would break a rule (e.g. both words the same length), so you cannot make it worse. The ' +
      'item stays pending and still needs a human to approve it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The review-queue id (from preview_questions).' },
        template: { type: 'string', description: 'New sentence, with exactly one {blank}.' },
        answer: { type: 'string', description: 'New correct word.' },
        alt_answer: { type: 'string', description: 'New wrong word — must be a DIFFERENT length.' },
      },
      required: ['id'],
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

ALSO: warm, simple, first-person sentences ("I am...", "I feel...").

VOCABULARY — REACH WIDE. Every question is a chance for a child to meet a word they do not have yet.
A pack of twelve questions built from six words teaches less than one built from twenty-four, so
before reusing anything, look for a word the pack has not used at all. get_pack_content returns
\`every_word_in_use\` for exactly this: treat it as the list to move AWAY from.

Two things to avoid, both of which teach the wrong lesson:
  • A WORD IN BOTH ROLES. If a word is the ANSWER in one question, do not make it the wrong option
    in another (or the reverse). The child is marked wrong for a word and right for it moments
    later. Worse, the wrong option is often GENUINELY correct in its sentence — "I stay PROUD when
    things go wrong" reads perfectly well — so a child who reads carefully is punished for it.
  • THE SAME WRONG OPTION REPEATEDLY. A predictable distractor teaches "it is never that one"
    instead of teaching the child to read the blank.

CHOOSE THE WRONG WORD ON PURPOSE. It should be positive, clearly a different length, and NOT a
sensible answer to that particular sentence. Read the sentence back with the wrong word in it: if it
still makes sense, the question has two right answers and only one of them scores.

The ONE hard rule about repetition remains: never reproduce an existing question EXACTLY — same
sentence AND the same two words. Reusing a sentence with a genuinely different pair is allowed.`;

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

    const answerWords = [...new Set([
      ...(qs || []).map((q: any) => (q.answer || '').toUpperCase()),
      ...(queued || []).map((q: any) => (q.answer || '').toUpperCase()),
    ].filter(Boolean))];

    // DISTRACTORS WERE NEVER SURFACED, and that is why words ended up playing both roles. Claude was
    // told which words are already ANSWERS and nothing about the wrong options, so it would pick a
    // distractor that is the correct answer two questions along. A child is then marked wrong for a
    // word and right for it moments later.
    const distractorWords = [...new Set([
      ...(qs || []).map((q: any) => (q.alt_answer || '').toUpperCase()),
      ...(queued || []).map((q: any) => (q.alt_answer || '').toUpperCase()),
    ].filter(Boolean))];

    const usedWords = answerWords;
    const everyWordInUse = [...new Set([...answerWords, ...distractorWords])].sort();

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
      answer_words_already_taken: answerWords,
      distractor_words_already_used: distractorWords,
      every_word_in_use: everyWordInUse,
      previously_rejected: rejectedWords,
      note: 'REACH FOR WORDS THAT ARE NOT IN every_word_in_use — either list. A pack is better for ' +
        'having a WIDE vocabulary, and a child meets more language that way. Two specific things to ' +
        'avoid: (1) using a word that is already an ANSWER as your wrong option, or a word already ' +
        'used as a wrong option as your answer — the child is marked wrong for a word and right for ' +
        'it a moment later, which teaches nothing but confusion; (2) leaning on the same wrong option ' +
        'repeatedly, which teaches "it is never that one" instead of reading the blank. ' +
        'Both words must still be POSITIVE and DIFFERENT LENGTHS. The only HARD rule remains: never ' +
        'reproduce an existing question exactly (same sentence AND the same right/wrong pair). ' +
        'Run check_questions before you propose.',
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

    // DUPLICATE SCAN — across the WHOLE database, not just this pack.
    // The engine's own `duplicate` flag only catches an identical sentence AND pair inside the same
    // pack. That misses the cases that actually occur: the same sentence with a different pair, a
    // sentence reworded by three words, the same question already living in another pack, and
    // anything sitting in the review queue rather than live. pm_find_similar uses a trigram index
    // over a normalised template (lowercased, {blank} removed, punctuation stripped) so a reword
    // cannot hide behind a comma.
    // Severity 1-2 (identical sentence) BLOCKS; 3-4 (reworded, or the same pair reused elsewhere)
    // advise. Rule 4.15: a duplicate sentence is a defect in the content; reusing a pair is a
    // variety judgement and must not stop a proposal.
    const dupFindings: Record<number, any[]> = {};
    for (let i = 0; i < list.length; i++) {
      const q: any = list[i];
      try {
        const { data: sim } = await db.rpc('pm_find_similar', {
          p_template: q.template, p_answer: q.answer, p_alt_answer: q.alt_answer,
        });
        if (Array.isArray(sim) && sim.length) dupFindings[i] = sim;
      } catch (_) { /* a failed scan must not block a proposal — it is a check, not a gate */ }
    }

    // VOCABULARY ADVICE — advisory, never blocking (rule 4.15: only defects that make a question
    // WRONG FOR A CHILD are hard). Cross-role reuse does not break the engine, so it must not stop
    // a proposal; it is a strong smell that the pack is recycling six words, and the reviewer and
    // the writer both deserve to see it.
    const answersInPack = new Set(existing.map((q: any) => (q.answer || '').toUpperCase()).filter(Boolean));
    const altsInPack = new Set(existing.map((q: any) => (q.alt_answer || '').toUpperCase()).filter(Boolean));

    // Validate cumulatively, so a word repeated WITHIN this batch is caught too.
    const seen = [...existing];
    const checked = list.map((q: any) => {
      const result = validateQuestion(q, levels || [], { targetLevel: pack.level ?? 1, existing: seen });

      const ans = (q.answer || '').toUpperCase();
      const alt = (q.alt_answer || '').toUpperCase();
      const advice: string[] = [];
      if (alt && answersInPack.has(alt)) {
        advice.push(`"${alt}" is already the ANSWER to another question in this pack. Using it as the ` +
          `wrong option means a child is marked right for it once and wrong for it here. Pick a ` +
          `different wrong word.`);
      }
      if (ans && altsInPack.has(ans)) {
        advice.push(`"${ans}" is already used as a WRONG option elsewhere in this pack. Making it the ` +
          `answer here contradicts that. Pick a different answer word, or change the other question.`);
      }
      if (ans && answersInPack.has(ans)) {
        advice.push(`"${ans}" is already an answer in this pack — allowed, but a fresh word would ` +
          `widen the vocabulary a child meets.`);
      }
      if (advice.length) (result as any).vocabulary_advice = advice;

      // Attach the duplicate findings, splitting blocking from advisory.
      const found = dupFindings[list.indexOf(q)] || [];
      const blocking = found.filter((f: any) => f.severity <= 2);
      const advisory = found.filter((f: any) => f.severity >= 3);
      const describe = (f: any) => ({
        reason: f.reason,
        found_in: f.source === 'queue' ? 'the review queue' : 'live content',
        pack: f.pack_name,
        question: `"${f.template}" — ${f.answer} / ${f.alt_answer}`,
        similarity: Math.round((f.similarity || 0) * 100) / 100,
      });
      if (blocking.length) {
        (result as any).ok = false;
        result.flags = [...(result.flags || []), {
          code: 'duplicate_elsewhere',
          detail: blocking[0].reason === 'exact_same_pair'
            ? `This question already exists in ${blocking[0].pack_name} (${blocking[0].source === 'queue' ? 'awaiting review' : 'live'}). Write a different one.`
            : `The SAME sentence is already used in ${blocking[0].pack_name}: "${blocking[0].template}" — ${blocking[0].answer} / ${blocking[0].alt_answer}. A child would meet the same sentence twice.`,
        }];
      }
      if (advisory.length) (result as any).similar_questions = advisory.map(describe);

      answersInPack.add(ans); altsInPack.add(alt);
      seen.push({ template: q.template, answer: q.answer, alt_answer: q.alt_answer, source: 'batch' });
      return { q, result };
    });

    const clean = checked.filter(c => c.result.ok);
    const flagged = checked.filter(c => !c.result.ok);

    // Computed above but previously not RETURNED — which made it worthless. A check that runs and
    // says nothing is the same as no check (rule 4.40: the observation has to reach a human).
    const vocab = checked
      .filter(c => (c.result as any).vocabulary_advice)
      .map(c => ({
        question: `"${c.q.template}" — ${c.q.answer} / ${c.q.alt_answer}`,
        advice: (c.result as any).vocabulary_advice,
      }));

    // Near-duplicates that did NOT block. Worth showing: a reworded question is usually a sign the
    // writer did not know the original existed, and the fix is a different question, not a comma.
    const similar = checked
      .filter(c => (c.result as any).similar_questions)
      .map(c => ({
        question: `"${c.q.template}" — ${c.q.answer} / ${c.q.alt_answer}`,
        resembles: (c.result as any).similar_questions,
      }));

    // check_questions: report only. Nothing is saved.
    if (name === 'check_questions') {
      return {
        checked: checked.length,
        passed: clean.length,
        problems: flagged.map(c => ({
          question: `"${c.q.template}" — ${c.q.answer} / ${c.q.alt_answer}`,
          problems: c.result.flags.map((f: any) => f.detail),
        })),
        vocabulary: vocab.length ? vocab : undefined,
        similar_questions: similar.length ? similar : undefined,
        note: (flagged.length
          ? 'Fix these and check again before proposing.'
          : 'Mechanically sound — you can propose these.') +
          (vocab.length
            ? ' NOTE the vocabulary points above: they do not block anything, but a pack that keeps ' +
              'recycling the same words teaches a child less. Prefer a fresh word where you can.'
            : ''),
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
    // Same advice on propose, since a writer who skips check_questions is exactly the one who
    // needs it — and the reviewer sees it in the queue either way.

    return {
      sent_for_review: res?.queued ?? checked.length,
      passed_every_check: clean.length,
      flagged: flagged.length,
      problems: flagged.map(c => ({
        question: `"${c.q.template}" — ${c.q.answer} / ${c.q.alt_answer}`,
        problems: c.result.flags.map((f: any) => f.detail),
      })),
      vocabulary: vocab.length ? vocab : undefined,
      similar_questions: similar.length ? similar : undefined,
      note: 'These are now waiting for a human to approve, edit or reject. Nothing is live yet. Call review_status later to see what was approved or rejected.',
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

  // ---- review_status ----
  // Read-only. FULL SHARED VISIBILITY (decision, Aug 2026): every partner sees EVERY contributor's
  // submissions, pending and decided, with attribution. This matches how the CMS itself works —
  // partners share the admin login, so scoping this per-caller was a boundary that did not actually
  // hold anywhere else. Seeing each other's rejections is also the fastest way to learn the bar.
  if (name === 'review_status') {
    let packFilter: any = null;
    if (args.pack_slug) {
      const { data: p } = await db.from('pm_packs').select('id,slug,name').eq('slug', args.pack_slug).maybeSingle();
      if (!p) return { error: `No pack with slug "${args.pack_slug}". Call list_packs to see what exists.` };
      packFilter = p;
    }

    const q = db.from('pm_review_queue')
      .select('pack_id,status,edited,reject_reason,answer,alt_answer,template,provider,created_at,decided_at,decided_by')
      .limit(5000);
    if (packFilter) q.eq('pack_id', packFilter.id);
    const { data: rows } = await q;

    const all = rows || [];
    const who = (r: any) => (r.provider || 'unknown').replace(/^partner:/, '');
    const byStatus = (s: string) => all.filter((r: any) => r.status === s);
    const pending = byStatus('pending'), approved = byStatus('approved'), rejected = byStatus('rejected');

    const { data: packs } = await db.from('pm_packs').select('id,slug,name').limit(500);
    const packById: Record<string, any> = {};
    for (const p of packs || []) packById[p.id] = p;
    const packName = (id: string) => packById[id]?.name || 'unknown';

    // Per-pack and per-contributor breakdowns.
    const perPack: Record<string, any> = {};
    const perContributor: Record<string, any> = {};
    for (const r of all) {
      const pk = packById[r.pack_id]?.slug || 'unknown';
      perPack[pk] = perPack[pk] || { pack: packName(r.pack_id), pending: 0, approved: 0, rejected: 0 };
      if (perPack[pk][r.status] != null) perPack[pk][r.status] += 1;

      const c = who(r);
      perContributor[c] = perContributor[c] || { pending: 0, approved: 0, rejected: 0, approved_but_edited_first: 0 };
      if (perContributor[c][r.status] != null) perContributor[c][r.status] += 1;
      if (r.status === 'approved' && r.edited) perContributor[c].approved_but_edited_first += 1;
    }

    const shape = (r: any) => ({
      question: `"${(r.template || '').replace(/\{blank\}/g, '____')}" — ${r.answer} / ${r.alt_answer}`,
      pack: packName(r.pack_id),
      by: who(r),
    });

    // Everything still waiting on the reviewer, so any partner can see the shared backlog.
    const awaiting = pending
      .sort((a: any, b: any) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
      .slice(0, 50)
      .map((r: any) => ({ ...shape(r), submitted: r.created_at }));

    // Rejections with reasons — the fastest way for ANY contributor to learn the bar.
    const rejections = rejected
      .sort((a: any, b: any) => String(b.decided_at || '').localeCompare(String(a.decided_at || '')))
      .slice(0, 25)
      .map((r: any) => ({ ...shape(r), reason: r.reject_reason || '(no reason given)' }));

    const meKey = partner;
    return {
      scope: packFilter ? `pack "${packFilter.name}"` : 'all packs',
      visibility: 'Shared — every partner sees every contributor\'s submissions.',
      totals_all_contributors: {
        total: all.length,
        awaiting_review: pending.length,
        approved: approved.length,
        rejected: rejected.length,
      },
      by_contributor: perContributor,
      by_pack: perPack,
      awaiting_review_now: awaiting,
      why_things_were_rejected: rejections,
      your_own: perContributor[meKey] || { pending: 0, approved: 0, rejected: 0, approved_but_edited_first: 0 },
      note: all.length === 0
        ? 'Nothing has been proposed yet' + (packFilter ? ' for this pack.' : '.')
        : (pending.length
            ? `${pending.length} question(s) are waiting for a human to approve, edit or reject.`
            : 'Everything proposed so far has been decided on.') +
          (rejections.length ? ' Read why_things_were_rejected before writing more — those reasons apply to everyone.' : ''),
    };
  }

  // ---- preview_questions ----
  // Renders a question the way a child actually sees it. This MIRRORS buildLevelVariants in core.jsx:
  // whole-word levels blank the entire word (min 3 underscores); otherwise maskWord hides
  // letters_hidden_default letters at the level's position/grouping. NOTE: frame_slots (slot
  // variations) are NOT resolved here — connector-proposed questions never set them, and adding
  // resolveSlots would create a fifth parity copy. If a row has slots, the preview says so.
  if (name === 'preview_questions') {
    const { data: levels } = await db.from('pm_levels').select('*').order('level').limit(200);
    const askedLevels = Array.isArray(args.levels) && args.levels.length ? args.levels : null;
    // DEFAULT TO ONE LEVEL, NOT ALL TEN. Returning every level for every question made the payload
    // overwhelmingly level-shaped (12 questions x 10 levels = 120 level objects), and the natural way
    // to summarise that is level-by-level — which is the opposite of "show me the questions".
    const wanted = askedLevels
      ? (levels || []).filter((l: any) => askedLevels.includes(l.level))
      : (levels || []).slice(0, 1);

    const maskAt = (word: string, lvl: any) => {
      const isWord = lvl.hidden_mode === 'word';
      const letters = isWord ? word.length : Math.min(lvl.letters_hidden_default || 2, Math.max(1, word.length - 1));
      return (isWord || letters >= word.length)
        ? '_'.repeat(Math.max(3, word.length))
        : maskWord(word, letters, lvl.letter_position || 'end', lvl.letter_grouping || 'grouped');
    };

    // QUESTION-FIRST: the sentence and the two words are the headline; levels are a compact list
    // underneath for the card's tabs.
    const renderOne = (q: any) => {
      const word = (q.answer || '').toUpperCase();
      const alt = (q.alt_answer || '').toUpperCase();
      const shown = wanted[0] || (levels || [])[0];
      return {
        sentence: (q.template || '').replace(/\{blank\}/g, shown ? maskAt(word, shown) : '____'),
        options: [word, alt],
        correct: word,
        level_shown: shown ? shown.level : null,
        at_other_levels: (askedLevels ? wanted : (levels || [])).map((lvl: any) => ({
          level: lvl.level,
          sentence: (q.template || '').replace(/\{blank\}/g, maskAt(word, lvl)),
        })),
      };
    };

    // Drafts supplied directly?
    if (Array.isArray(args.questions) && args.questions.length) {
      return {
        source: 'drafts (nothing saved)',
        previews: args.questions.slice(0, 30).map((q: any, i: number) => ({
          n: i + 1,
          ...renderOne(q),
        })),
        note: 'This is exactly how each one appears in the game. Check the TONE and MEANING here — the engine already checks the mechanics. Run check_questions before proposing.',
      };
    }

    // Otherwise: preview saved questions — either the pending queue, or a pack's live bank.
    let packFilter: any = null;
    if (args.pack_slug) {
      const { data: p } = await db.from('pm_packs').select('id,slug,name').eq('slug', args.pack_slug).maybeSingle();
      if (!p) return { error: `No pack with slug "${args.pack_slug}". Call list_packs to see what exists.` };
      packFilter = p;
    }

    const source = args.source === 'live' ? 'live' : 'pending';

    // ---- live: the pack's already-approved question bank ----
    if (source === 'live') {
      if (!packFilter) return { error: 'To play a live question bank, say which pack — pass pack_slug.' };
      // Count the true total separately. Reporting only the capped length silently under-reports once
      // a pack passes the cap — the exact silent-truncation trap that has bitten this project before.
      const { count: liveTotal } = await db.from('pm_questions')
        .select('id', { count: 'exact', head: true })
        .eq('pack_id', packFilter.id).eq('status', 'active');
      const { data: live } = await db.from('pm_questions')
        .select('id,template,answer,alt_answer')
        .eq('pack_id', packFilter.id).eq('status', 'active').order('sort_order').limit(PREVIEW_CAP);
      const liveShown = (live || []).length;
      return {
        source: `LIVE question bank — pack "${packFilter.name}" (already approved and in the game)`,
        total_in_pack: liveTotal ?? liveShown,
        showing: liveShown,
        truncated: (liveTotal ?? 0) > liveShown,
        previews: (live || []).map((r: any, i: number) => ({
          n: i + 1,
          // NOT a review-queue id — a live question id. Named so it cannot be mistaken for one that
          // reject_questions/edit_queued_question accept, which only ever take PENDING queue ids.
          question_id: r.id,
          pack: packFilter.name,
          ...renderOne(r),
        })),
        note: liveShown
          ? 'These are LIVE questions children can already see. Render them as playable cards. They cannot be edited or rejected from here — that is done in the CMS.' +
            ((liveTotal ?? 0) > liveShown ? ` Showing the first ${liveShown} of ${liveTotal} — ask for specific levels or a follow-up batch to see the rest.` : '')
          : 'This pack has no approved questions yet.',
      };
    }

    // ---- pending: what is awaiting review ----
    const qCount = db.from('pm_review_queue').select('id', { count: 'exact', head: true }).eq('status', 'pending');
    if (packFilter) qCount.eq('pack_id', packFilter.id);
    const { count: pendingTotal } = await qCount;

    const qq = db.from('pm_review_queue')
      .select('id,pack_id,template,answer,alt_answer,provider,frame_slots,created_at')
      .eq('status', 'pending').order('created_at').limit(PREVIEW_CAP);
    if (packFilter) qq.eq('pack_id', packFilter.id);
    const { data: queued } = await qq;
    const pendingShown = (queued || []).length;

    const { data: packs } = await db.from('pm_packs').select('id,name').limit(500);
    const packName: Record<string, string> = {};
    for (const p of packs || []) packName[p.id] = p.name;

    return {
      source: packFilter ? `pending review queue — pack "${packFilter.name}"` : 'pending review queue (all packs)',
      total_awaiting: pendingTotal ?? pendingShown,
      showing: pendingShown,
      truncated: (pendingTotal ?? 0) > pendingShown,
      previews: (queued || []).map((r: any, i: number) => ({
        n: i + 1,
        id: r.id,
        pack: packName[r.pack_id] || 'unknown',
        by: (r.provider || 'unknown').replace(/^partner:/, ''),
        ...renderOne(r),
        has_slot_variations: !!(r.frame_slots && Object.keys(r.frame_slots).length),
      })),
      note: pendingShown
        ? 'Render these as playable cards. The person can reject any with reject_questions (using the id), or fix one with edit_queued_question. APPROVING is not possible here — that is done in the CMS.' +
          ((pendingTotal ?? 0) > pendingShown ? ` Showing the first ${pendingShown} of ${pendingTotal} still waiting.` : '')
        : 'Nothing is awaiting review. If they wanted to play a pack\'s existing questions, call this again with source:"live" and a pack_slug.',
    };
  }

  // ---- reject_questions ----
  // Safe by construction: rejecting only removes something from the pipeline. pm_review_reject
  // enforces status='pending' itself. It stamps decided_by from a JWT email, which the connector
  // (service role) does not have — so it would record 'admin'. We patch the real actor in after.
  // APPROVE — one at a time, for any token with can_approve (DEFAULT TRUE since 11 Aug 2026).
  // Rule 4.19 withheld this for two reasons. The first (every token equally powerful) is answered
  // by the per-token flag EXISTING, not by its default: approval can be withdrawn from any single
  // token with one UPDATE and takes effect on its next request. Albert chose default-on knowingly —
  // a partner approving is still a HUMAN approving, which is what the invariant protects. What it
  // costs is the second pair of eyes: the writer and the reviewer may now be the same person. The second
  // (reviewing content in the chat that generated it is a worse review environment) has no
  // technical fix, so the design leans on making review REAL rather than fast:
  //   • ONE AT A TIME. No bulk. The defects that matter here — a same-length pair, a distractor
  //     that also fits — are invisible in a list and only surface when you PLAY the question.
  //   • confirm_answer MUST match. Statelessly, we cannot verify the caller previewed anything;
  //     requiring the answer word back proves they have at least SEEN the question rather than
  //     approving an id read off a list.
  if (name === 'approve_question') {
    if (!who?.can_approve) {
      return { error: 'This token cannot approve. Approval is granted per token; ask Albert to enable it.' };
    }
    const qid = String(args.id || '').trim();
    if (!qid) return { error: 'Which question? Pass the review-queue id from preview_questions.' };

    const { data: row } = await db.from('pm_review_queue')
      .select('id, pack_id, template, answer, alt_answer, status, provider, validation')
      .eq('id', qid).maybeSingle();
    if (!row) return { error: 'No question in the review queue with that id.' };
    if (row.status !== 'pending') {
      return { error: `That question was already ${row.status}. Nothing changed.` };
    }

    const confirm = String(args.confirm_answer || '').trim().toUpperCase();
    if (!confirm || confirm !== String(row.answer || '').toUpperCase()) {
      return {
        error: 'confirm_answer must be the CORRECT word for this question, exactly as it appears. ' +
               'Preview the question first and read it off the card — this exists so a question ' +
               'cannot be approved from a list without being looked at.',
        question: `"${row.template}"`,
      };
    }

    const { data: res, error } = await db.rpc('pm_review_approve', { p_id: qid });
    if (error) return { error: String(error.message || error) };

    return {
      approved: `"${row.template}" — ${row.answer} / ${row.alt_answer}`,
      question_id: (res as any)?.question_id ?? null,
      note: 'This is now LIVE and the game will pick it up on its next sync. If that was a mistake, ' +
            'unapprove_question puts it back in the queue and removes it from the game.',
    };
  }

  // UNDO. Only ever REMOVES content from children, which is what makes it safe under rule 4.19 —
  // the same reasoning that permits reject_questions.
  if (name === 'unapprove_question') {
    if (!who?.can_approve) return { error: 'This token cannot approve or unapprove.' };
    const qid = String(args.question_id || '').trim();
    if (!qid) return { error: 'Pass question_id — the LIVE question id returned when it was approved.' };
    const { data, error } = await db.rpc('pm_connector_unapprove', {
      p_question_id: qid, p_reason: args.reason || null,
    });
    if (error) return { error: String(error.message || error) };
    return data;
  }

  if (name === 'reject_questions') {
    const ids: string[] = Array.isArray(args.ids) ? args.ids.filter(Boolean) : [];
    if (!ids.length) return { error: 'No ids given. Get them from preview_questions.' };
    if (ids.length > 30) return { error: 'Too many at once — 30 maximum per call.' };
    const reason = String(args.reason || '').trim();
    if (!reason) return { error: 'Give a reason — it is shown to whoever wrote the question.' };

    const done: any[] = [], failed: any[] = [];
    for (const id of ids) {
      const { error } = await db.rpc('pm_review_reject', { p_id: id, p_reason: reason });
      if (error) { failed.push({ id, why: String(error.message || error) }); continue; }
      // Record who actually rejected it (the RPC cannot see the partner).
      try {
        await db.from('pm_review_queue').update({ decided_by: `partner:${partner}` }).eq('id', id);
      } catch { /* attribution is best-effort */ }
      done.push(id);
    }

    return {
      rejected: done.length,
      rejected_ids: done,
      failed,
      reason,
      note: failed.length
        ? 'Some could not be rejected — most likely they were already approved or rejected.'
        : 'Rejected. They are out of the queue and will not reach a child. Nothing was deleted — they stay on record with the reason.',
    };
  }

  // ---- edit_queued_question ----
  // Fixes a PENDING item in place. Safe: it stays pending and still needs human approval. The edit is
  // re-validated with the full engine, so it cannot be made worse. Deliberately does NOT set the
  // `edited` flag — that flag means "the APPROVER changed it at approval time" (see pm_review_approve)
  // and is what review_status reports as approved_but_edited_first.
  if (name === 'edit_queued_question') {
    const { data: row } = await db.from('pm_review_queue')
      .select('id,pack_id,template,answer,alt_answer,status').eq('id', args.id).maybeSingle();
    if (!row) return { error: `No review-queue item with id "${args.id}". Get ids from preview_questions.` };
    if (row.status !== 'pending') return { error: `That item is already ${row.status} — only pending items can be edited.` };

    const merged = {
      template: args.template != null ? String(args.template) : row.template,
      answer: args.answer != null ? String(args.answer).toUpperCase().trim() : row.answer,
      alt_answer: args.alt_answer != null ? String(args.alt_answer).toUpperCase().trim() : row.alt_answer,
    };
    if (merged.template === row.template && merged.answer === row.answer && merged.alt_answer === row.alt_answer) {
      return { error: 'Nothing changed — supply a new template, answer or alt_answer.' };
    }

    const { data: pack } = await db.from('pm_packs').select('id,name,level').eq('id', row.pack_id).maybeSingle();
    const { data: levels } = await db.from('pm_levels').select('*').order('level').limit(200);
    const { data: liveQs } = await db.from('pm_questions')
      .select('template,answer,alt_answer').eq('pack_id', row.pack_id).limit(2000);
    const { data: otherQueued } = await db.from('pm_review_queue')
      .select('id,template,answer,alt_answer,status')
      .eq('pack_id', row.pack_id).in('status', ['pending', 'rejected']).limit(2000);

    // Exclude the row being edited, or it would flag itself as a duplicate.
    const existing = [
      ...(liveQs || []),
      ...(otherQueued || []).filter((q: any) => q.id !== row.id),
    ];

    const result = validateQuestion(merged, levels || [], { targetLevel: pack?.level ?? 1, existing });
    if (!result.ok) {
      return {
        saved: false,
        problems: result.flags.map((f: any) => f.detail),
        note: 'NOT saved — the edit would break a rule. Fix these and try again; the original is untouched.',
      };
    }

    const { error: uErr } = await db.from('pm_review_queue')
      .update({ template: merged.template, answer: merged.answer, alt_answer: merged.alt_answer, validation: result })
      .eq('id', row.id);
    if (uErr) return { error: String(uErr.message || uErr) };

    return {
      saved: true,
      was: `"${row.template}" — ${row.answer} / ${row.alt_answer}`,
      now: `"${merged.template}" — ${merged.answer} / ${merged.alt_answer}`,
      note: 'Updated and re-checked against the engine. It is still PENDING and still needs a human to approve it. Call preview_questions to see how it now looks to a child.',
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
      grant_types_supported: ['authorization_code', 'refresh_token'],
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
      // MUST include refresh_token. This response tells the client what it is ALLOWED to do, and a
      // client that is told authorization_code only will never attempt a refresh — no matter what
      // the server metadata advertises or what the token endpoint actually returns.
      // That is exactly how the connector broke: the token endpoint issued refresh tokens, the
      // metadata advertised the grant, and this line quietly said no. Claude concluded the
      // connection could not be renewed and showed "Connection has expired" on every attempt.
      // The refresh grant is implemented below and is not gated on this list, so this was purely a
      // false advertisement — the most expensive kind of wrong, because everything else looks right.
      grant_types: ['authorization_code', 'refresh_token'],
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
      .select('id, partner, active, can_approve').eq('token_hash', hash).eq('active', true).maybeSingle();
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

    // ---- refresh_token grant --------------------------------------------------------------
    // Anthropic's connector docs: "Claude supports token expiry and refresh — servers should
    // support this functionality." Ours did not, so a connection had no way to stay alive and
    // Claude had nothing to call when its access token aged out; the only route back was a full
    // manual reconnect. PKCE is deliberately NOT required here — RFC 7636 applies it to the
    // authorization code exchange, not to refresh.
    if (grant === 'refresh_token') {
      const rt = params.get('refresh_token') || '';
      if (!rt) return json({ error: 'invalid_request', error_description: 'refresh_token required' }, 400);

      const { data: old } = await db.from('pm_oauth_tokens')
        .select('access_token, token_id, client_id, refresh_expires_at')
        .eq('refresh_token', rt).maybeSingle();
      if (!old) return json({ error: 'invalid_grant', error_description: 'Unknown refresh token' }, 400);
      if (old.refresh_expires_at && new Date(old.refresh_expires_at) < new Date()) {
        return json({ error: 'invalid_grant', error_description: 'Refresh token expired' }, 400);
      }
      // The client must be the one the token was issued to.
      const cid = params.get('client_id') || '';
      if (cid && old.client_id && cid !== old.client_id) {
        return json({ error: 'invalid_grant', error_description: 'client_id mismatch' }, 400);
      }
      // The partner may have been revoked since — a refresh must not resurrect access.
      const { data: p } = await db.from('pm_mcp_tokens')
        .select('active').eq('id', old.token_id).maybeSingle();
      if (!p || !p.active) return json({ error: 'invalid_grant', error_description: 'Access revoked' }, 400);

      const newAccess = randomToken('at_');
      const newRefresh = randomToken('rt_');
      const ttl = ACCESS_TTL;
      const rttl = REFRESH_TTL;
      await db.from('pm_oauth_tokens').insert({
        access_token: newAccess,
        token_id: old.token_id,
        client_id: old.client_id,
        expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
        refresh_token: newRefresh,
        refresh_expires_at: new Date(Date.now() + rttl * 1000).toISOString(),
      });
      // ROTATE: retire the old pair so a leaked refresh token cannot be replayed. Done AFTER the
      // new row exists, so a failure here leaves the caller with working credentials rather than
      // none.
      await db.from('pm_oauth_tokens').delete().eq('access_token', old.access_token);

      return json({
        access_token: newAccess,
        token_type: 'Bearer',
        expires_in: ttl,
        refresh_token: newRefresh,
        scope: 'mcp:tools',
      });
    }

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
    const refreshToken = randomToken('rt_');
    const expiresIn = ACCESS_TTL;
    const refreshExpiresIn = REFRESH_TTL;
    await db.from('pm_oauth_tokens').insert({
      access_token: accessToken,
      token_id: row.token_id,
      client_id: row.client_id,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      refresh_token: refreshToken,
      refresh_expires_at: new Date(Date.now() + refreshExpiresIn * 1000).toISOString(),
    });

    return json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken,
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

  // AUTH FIRST, INCLUDING FOR initialize.
  // This used to answer initialize with 200 for anyone, on the reasoning that "the handshake
  // precedes the token". That is backwards for a PROTECTED resource: the 401 with WWW-Authenticate
  // IS the handshake — it is how a client learns it must run the OAuth flow, and the spec expects
  // the client to retry initialize once it holds a token. Answering 200 unauthenticated means the
  // very first probe succeeds, so the client can conclude the server needs no credentials and then
  // meet a 401 on the first real call.
  // notifications/initialized stays open: it is fire-and-forget, carries no data, and a 401 on a
  // notification has nowhere to go.
  const who = await authenticate(db, req);
  if (!who && method !== 'notifications/initialized') {
    // CRITICAL: the WWW-Authenticate header is how Claude discovers it needs to run the OAuth flow.
    // Without it, the connector just fails and never offers to sign in.
    return json(
      { jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message: 'Unauthorized' } },
      401,
      { 'WWW-Authenticate': `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"` },
    );
  }

  if (method === 'initialize') {
    return rpcOk({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'positive-minds', version: '1.0.0' },
      instructions:
        'Positive Minds — therapeutic word-puzzle content for children. ROUTE BY WHAT IS ASKED:\n' +
        '• PREVIEW / PLAY / REVIEW WHAT IS PENDING — "preview the pending questions", "show me these ' +
        'as a child would see them", "play the question bank", "go through the queue", "what does the ' +
        'child see": go STRAIGHT to preview_questions. Do NOT call list_packs first — list_packs ' +
        'returns LEVEL RULES (how many letters are hidden, word lengths), not questions, and showing ' +
        'those instead of the actual questions is the wrong answer to this request. Default shows what ' +
        'is awaiting review; source:"live" with a pack_slug plays a pack\'s approved bank. Then render ' +
        'the result as an interactive PLAYABLE artifact: one card per QUESTION showing its sentence ' +
        'with the blank, tabs to switch level, and the two words as tappable buttons that go green or ' +
        'red, with the correct one hidden until tapped.\n' +
        '• WRITING NEW CONTENT: call list_packs first (it returns the brief), then get_pack_content ' +
        'for the chosen pack, then check_questions on your drafts, and only then propose_questions. ' +
        'Nothing you propose goes live — a human reviews every question.\n' +
        '• PROGRESS / HOW MANY: review_status (counts and decisions only — it does not show questions).\n' +
        '• PACKS: create_pack for a theme that does not exist yet, update_pack to change one\'s details. ' +
        'A new pack appears in the CMS immediately; its questions still go to the review queue.\n' +
        '• FIXING THE QUEUE: edit_queued_question to correct a pending item, reject_questions to drop ' +
        'one. APPROVING one question is possible ONLY for a token granted approval rights, and only ' +
        'one at a time after previewing it — see approve_question. There is no bulk approve, on ' +
        'purpose: the defects that matter only show when a question is played.',
    });
  }
  if (method === 'notifications/initialized') return new Response(null, { status: 202, headers: cors });

  if (method === 'tools/list') {
    // Tokens without approval rights never SEE these tools. A capability that is absent cannot be
    // attempted, argued with, or half-explained — which is a better boundary than a refusal.
    const visible = who?.can_approve
      ? TOOLS
      : TOOLS.filter((t: any) => t.name !== 'approve_question' && t.name !== 'unapprove_question');
    return rpcOk({ tools: visible });
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
