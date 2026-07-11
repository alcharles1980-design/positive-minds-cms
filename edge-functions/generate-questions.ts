// generate-questions — AI content generation with mandatory validation + human review queue.
//
// SECURITY MODEL:
//   • verify_jwt = true → only a logged-in CMS admin can invoke this.
//   • API keys live in pm_ai_config, which the browser CANNOT read (no RLS select policy).
//     This function reads them with the service role, server-side only. Keys never reach a client.
//   • Generated questions are written to pm_review_queue — NEVER directly to pm_questions.
//     A human must Approve / Edit / Reject each one.
//
// VALIDATION:
//   Every generated question is checked against the REAL masking engine at EVERY level before it
//   is queued. Most quality rules for this game are mechanically decidable (one {blank}; the
//   alternate must not ALSO fit the blank at any level; word-length band; duplicates), so the
//   machine catches its own errors before a human sees them. Failures can be auto-repaired by
//   sending the specific defect back to the model once.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// ============================================================
// The rendering engine — MUST mirror core.jsx / content-api byte-for-byte.
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

// Does `alt` ALSO satisfy this blank? If so, the puzzle has two correct answers.
function altFitsBlank(blank: string, alt: string): boolean {
  alt = (alt || '').toUpperCase();
  if (alt.length !== blank.length) return false;
  for (let i = 0; i < blank.length; i++) {
    if (blank[i] !== '_' && blank[i] !== alt[i]) return false;
  }
  return true;
}

// ============================================================
// THE VALIDATOR (mirror of the client's validateQuestion — keep identical)
// ============================================================
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

  // Ambiguity across EVERY level — the defect humans miss.
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

  // Level vocabulary rules
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
  // Duplicate detection has THREE distinct cases, because they mean different things:
  //   duplicate      — same sentence AND same answer. Definitely reject.
  //   same_sentence  — same sentence, different answer. Repetitive phrasing.
  //   answer_reused  — this answer word is already taught elsewhere. In a 10–20 question pack,
  //                    teaching BRAVE twice is a real quality problem, and it is INVISIBLE if you
  //                    only compare whole questions.
  // `existing` includes live questions AND anything already pending/rejected in the review queue —
  // otherwise two generate runs before a review duplicate each other, and a rejected question gets
  // cheerfully regenerated.
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
        flags.push({ code: 'answer_reused', detail: `The answer "${ans}" ${where}${reusedIn.template ? ` — “${String(reusedIn.template).replace(/\{blank\}/g, '____')}”` : ''}.` });
      }
    }
  }

  return { ok: flags.length === 0, flags };
}

// ============================================================
// Provider adapters — three genuinely different API shapes.
// Each returns the model's raw TEXT; parsing is shared.
// ============================================================
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
};

async function callAnthropic(key: string, model: string, prompt: string, maxTokens: number) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  const text = (d.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  return { text, usage: { input: d.usage?.input_tokens ?? null, output: d.usage?.output_tokens ?? null } };
}

async function callOpenAI(key: string, model: string, prompt: string, maxTokens: number) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_completion_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  const text = d.choices?.[0]?.message?.content || '';
  return { text, usage: { input: d.usage?.prompt_tokens ?? null, output: d.usage?.completion_tokens ?? null } };
}

async function callGemini(key: string, model: string, prompt: string, maxTokens: number) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  const text = (d.candidates?.[0]?.content?.parts || []).map((p: any) => p.text || '').join('');
  return { text, usage: { input: d.usageMetadata?.promptTokenCount ?? null, output: d.usageMetadata?.candidatesTokenCount ?? null } };
}

async function callProvider(provider: string, key: string, model: string, prompt: string, maxTokens = 4000) {
  if (provider === 'anthropic') return callAnthropic(key, model, prompt, maxTokens);
  if (provider === 'openai') return callOpenAI(key, model, prompt, maxTokens);
  if (provider === 'gemini') return callGemini(key, model, prompt, maxTokens);
  throw new Error(`Unknown provider: ${provider}`);
}

// Pull a JSON array out of a model response (strips fences/preamble).
function parseQuestions(text: string): any[] {
  let t = (text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  const arr = JSON.parse(t);
  if (!Array.isArray(arr)) throw new Error('Model did not return a JSON array.');
  return arr;
}

// ============================================================
// Prompt construction
// ============================================================
function buildPrompt(opts: any) {
  const { pack, levelDefs, targetLevel, count, existing, notes } = opts;
  const L = levelDefs.find((l: any) => l.level === targetLevel);
  const lines: string[] = [];

  lines.push(`You are authoring content for a children's CBMT (Cognitive Bias Modification Therapy) word game for kids roughly aged 5-12.`);
  lines.push('');
  lines.push(`THE GAME MECHANIC — read carefully, this is a SPELLING puzzle, not a meaning puzzle:`);
  lines.push(`A short first-person sentence appears with one word partly hidden, e.g. "I feel PR_UD when I try." The child is shown TWO words and must pick the one whose SPELLING fits the revealed letters and the number of blanks. BOTH words are always POSITIVE — never show a child a negative word about themselves. That is the therapeutic core.`);
  lines.push('');
  lines.push(`CRITICAL CONSTRAINT — how the wrong option is guaranteed wrong:`);
  lines.push(`The alternate word must NOT be able to spell into the blank pattern. At the highest levels the WHOLE word is hidden, so the ONLY clue is its LENGTH. Therefore the alternate MUST be a DIFFERENT LENGTH from the primary answer. If both words are the same length, the puzzle has TWO correct answers and is broken.`);
  lines.push(`Example GOOD: primary PROUD (5 letters), alternate CALM (4 letters) — different lengths, both positive.`);
  lines.push(`Example BROKEN: primary BRIGHT (6), alternate GENTLE (6) — same length, so at whole-word levels both fit "______".`);
  lines.push('');

  if (pack?.name) {
    lines.push(`PACK: ${pack.name}${pack.emoji ? ' ' + pack.emoji : ''}`);
    if (pack.description) lines.push(`Description: ${pack.description}`);
    if (pack.purpose) lines.push(`Purpose: ${pack.purpose}`);
    if (pack.focus_areas) lines.push(`Focus areas: ${pack.focus_areas}`);
    lines.push('');
  }

  if (L) {
    lines.push(`TARGET LEVEL ${L.level}${L.name ? ` (${L.name})` : ''}`);
    if (L.theme) lines.push(`Theme: ${L.theme}`);
    if (L.age_hint) lines.push(`Ages: ${L.age_hint}`);
    const wc: string[] = [];
    if (L.min_word_len && L.max_word_len) wc.push(`answer words ${L.min_word_len}-${L.max_word_len} letters`);
    else if (L.min_word_len) wc.push(`answer words at least ${L.min_word_len} letters`);
    else if (L.max_word_len) wc.push(`answer words at most ${L.max_word_len} letters`);
    if (L.allow_multiword) wc.push('two-word answers allowed'); else wc.push('single words only');
    if (L.vocab_rule) wc.push(L.vocab_rule);
    if (wc.length) lines.push(`Word rules: ${wc.join('; ')}.`);
    if (L.min_word_len || L.max_word_len) lines.push(`BOTH words must fall in that band while STILL being different lengths from each other.`);
    lines.push('');
  }

  lines.push(`RULES:`);
  lines.push(`1. Every sentence has exactly one {blank} placeholder.`);
  lines.push(`2. Two answer words, BOTH genuinely positive and age-appropriate. The first is correct.`);
  lines.push(`3. The two words MUST be different lengths (see the critical constraint above).`);
  lines.push(`4. Words are UPPERCASE, letters only, no punctuation.`);
  lines.push(`5. Sentences are warm, simple, first-person ("I am...", "I feel...", "Being..."), self-affirming.`);
  lines.push(`6. Nothing scary, negative, clinical, or that implies the child did something wrong.`);
  lines.push(`7. No duplicates; vary the sentence structure.`);
  lines.push('');

  if (existing?.length) {
    // Every answer word already spoken for — whether live in the pack, waiting in the review queue,
    // or previously rejected. No cap: if the model doesn't see a word, it will happily reuse it.
    const used = [...new Set(existing.map((e: any) => String(e.answer || '').toUpperCase()).filter(Boolean))];
    const rejected = [...new Set(existing.filter((e: any) => e.source === 'rejected')
      .map((e: any) => String(e.answer || '').toUpperCase()).filter(Boolean))];

    if (used.length) {
      lines.push(`ANSWER WORDS ALREADY TAKEN — do NOT use any of these as the primary answer (each word should be taught once):`);
      lines.push(used.join(', '));
      lines.push('');
    }
    if (rejected.length) {
      lines.push(`Note: ${rejected.join(', ')} were previously REJECTED by a human reviewer — avoid them and anything close to them.`);
      lines.push('');
    }
    // Also show the sentences, so the model varies phrasing rather than just swapping words.
    const sentences = [...new Set(existing.map((e: any) => String(e.template || '').replace(/\{blank\}/g, '___')).filter(Boolean))].slice(0, 60);
    if (sentences.length) {
      lines.push(`SENTENCES ALREADY USED — write genuinely different ones, don't just swap the word:`);
      for (const t of sentences) lines.push(`- ${t}`);
      lines.push('');
    }
  }
  if (notes) { lines.push(`ADDITIONAL INSTRUCTIONS: ${notes}`); lines.push(''); }

  lines.push(`Produce ${count} questions.`);
  lines.push('');
  lines.push(`OUTPUT: Return ONLY a JSON array. No markdown, no preamble, no explanation.`);
  lines.push(`[{"template":"I am {blank} when I try new things","answer":"BRAVE","alt_answer":"BOLD"}]`);

  return lines.join('\n');
}

// Repair prompt: hand the model its own broken rows plus the exact defect.
function buildRepairPrompt(bad: any[], levelDefs: any[], targetLevel: number) {
  const lines: string[] = [];
  lines.push(`These questions you produced FAILED automated validation for a children's spelling game. Fix each one.`);
  lines.push('');
  lines.push(`Remember: BOTH words must be positive, and the alternate MUST be a DIFFERENT LENGTH from the primary answer (at high levels the whole word is hidden, so equal-length options both fit and the puzzle breaks).`);
  lines.push('');
  for (const b of bad) {
    lines.push(`- {"template":"${b.q.template}","answer":"${b.q.answer}","alt_answer":"${b.q.alt_answer}"}`);
    for (const f of b.result.flags) lines.push(`    PROBLEM: ${f.detail}`);
  }
  lines.push('');
  lines.push(`Return ONLY a JSON array of the CORRECTED questions, same shape, same count. No preamble.`);
  return lines.join('\n');
}


// Record every provider call. AI generation is the ONE thing in this app that spends real money,
// and until now it left no trace at all — no audit trail, no token counts, no way to see a runaway.
// Best-effort: a logging failure must never break a generation the user is waiting on.
async function logUsage(db: any, o: any) {
  try {
    await db.from('pm_ai_usage').insert({
      provider: o.provider, model: o.model ?? null, pack_id: o.pack_id ?? null,
      batch_id: o.batch_id ?? null, kind: o.kind ?? 'generate',
      input_tokens: o.usage?.input ?? null, output_tokens: o.usage?.output ?? null,
      questions_returned: o.questions ?? null,
      ok: o.ok !== false, error: o.error ?? null, actor: o.actor ?? null,
    });
  } catch { /* never let logging break the request */ }
}

// Who is calling? The JWT is already verified by the platform (verify_jwt=true); we just read the
// email out of it for the audit trail.
function actorFrom(req: Request): string {
  try {
    const auth = req.headers.get('authorization') || '';
    const tok = auth.replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(atob(tok.split('.')[1] || ''));
    return payload?.email || payload?.sub || 'admin';
  } catch { return 'admin'; }
}

// ============================================================
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const db = createClient(SUPABASE_URL, SERVICE_KEY);
  const actor = actorFrom(req);

  try {
    const body = await req.json();
    const {
      pack_id, target_level, count = 10, notes = '',
      provider: reqProvider, test_only = false,
    } = body || {};

    // ---- Resolve provider + key (server-side; the key never leaves this function) ----
    const { data: settings } = await db.from('pm_ai_settings').select('*').eq('id', 1).maybeSingle();
    const provider = reqProvider || settings?.active_provider || 'anthropic';

    const { data: cfg, error: cfgErr } = await db
      .from('pm_ai_config').select('*').eq('provider', provider).maybeSingle();
    if (cfgErr) throw cfgErr;
    if (!cfg?.api_key) {
      return json({ error: 'no_key', provider, message: `No API key saved for ${provider}. Add one in Settings.` }, 400);
    }
    const model = cfg.model || DEFAULT_MODELS[provider];

    // ---- Test-connection mode: smallest possible round-trip, nothing written ----
    if (test_only) {
      try {
        const t = await callProvider(provider, cfg.api_key, model, 'Reply with exactly: OK', 32);
        await logUsage(db, { provider, model, kind: 'test', usage: t.usage, ok: true, actor });
        return json({ ok: true, provider, model, reply: (t.text || '').trim().slice(0, 40) });
      } catch (e) {
        await logUsage(db, { provider, model, kind: 'test', ok: false, error: String(e).slice(0, 300), actor });
        return json({ ok: false, provider, model, error: String(e).slice(0, 300) }, 502);
      }
    }

    if (!pack_id) return json({ error: 'pack_id required' }, 400);

    // ---- RATE LIMIT: check BEFORE spending anything. A stuck loop, an impatient click, or a
    // compromised login could otherwise run up a real bill with no brake and no visibility. ----
    const { data: rate } = await db.rpc('pm_ai_rate_check', { p_max_hour: 20, p_max_day: 100 });
    if (rate && rate.allowed === false) {
      return json({
        error: 'rate_limited',
        message: `Too many generation runs (${rate.last_hour} in the last hour, ${rate.last_day} today). Limits: ${rate.max_hour}/hour, ${rate.max_day}/day. This is a safety brake on spend — try again later.`,
        last_hour: rate.last_hour, last_day: rate.last_day,
      }, 429);
    }

    // ---- Context: pack, levels, existing questions (for de-dup + avoid-list) ----
    const { data: pack } = await db.from('pm_packs').select('*').eq('id', pack_id).maybeSingle();
    if (!pack) return json({ error: 'Pack not found' }, 404);

    const { data: levels } = await db.from('pm_levels').select('*').order('level');

    // De-dup context. This must include MORE than the live questions, or:
    //   • two generate runs before you review will duplicate each other, and
    //   • a question you rejected gets cheerfully regenerated next time.
    // So: live questions (active AND inactive) + anything pending or already rejected in the queue.
    const { data: liveQs } = await db
      .from('pm_questions').select('template,answer,alt_answer').eq('pack_id', pack_id).limit(2000);
    const { data: queuedQs } = await db
      .from('pm_review_queue').select('template,answer,status')
      .eq('pack_id', pack_id).in('status', ['pending', 'rejected']).limit(2000);

    const existing = [
      ...(liveQs || []).map((q: any) => ({ ...q, source: 'live' })),
      ...(queuedQs || []).map((q: any) => ({ ...q, source: q.status })), // 'pending' | 'rejected'
    ];

    const tLevel = target_level ?? pack.level ?? 1;

    // ---- Generate ----
    const prompt = buildPrompt({
      pack, levelDefs: levels || [], targetLevel: tLevel,
      count: Math.min(Math.max(count, 1), 30), existing: existing || [], notes,
    });

    let raw: string;
    let genUsage: any = { input: null, output: null };
    try {
      const res = await callProvider(provider, cfg.api_key, model, prompt, 4000);
      raw = res.text; genUsage = res.usage;
    } catch (e) {
      await logUsage(db, { provider, model, pack_id, kind: 'generate', ok: false, error: String(e).slice(0, 300), actor });
      return json({ error: 'provider_error', provider, message: String(e).slice(0, 400) }, 502);
    }

    let items: any[];
    try { items = parseQuestions(raw); }
    catch (e) { return json({ error: 'parse_error', message: String(e), raw: raw.slice(0, 600) }, 502); }

    // ---- Validate every item against the REAL engine at EVERY level ----
    // Validate a list cumulatively: each item is checked against `existing` PLUS everything already
    // seen (either previously accepted in this batch, or earlier in the same list) — otherwise the
    // model can hand back BRAVE twice in one run and neither copy gets flagged.
    const validateList = (list: any[], seed: any[]) => {
      const seen: any[] = [...seed];
      return list.map((q: any) => {
        const result = validateQuestion(q, levels || [], { targetLevel: tLevel, existing: seen });
        seen.push({ template: q.template, answer: q.answer, source: 'batch' });
        return { q, result };
      });
    };
    let checked = validateList(items, existing || []);

    // ---- Auto-repair one round for failures (if enabled) ----
    let repaired = 0;
    const autoRepair = settings?.auto_repair !== false;
    const bad = checked.filter((c) => !c.result.ok);
    if (autoRepair && bad.length) {
      try {
        const rprompt = buildRepairPrompt(bad, levels || [], tLevel);
        const rres = await callProvider(provider, cfg.api_key, model, rprompt, 4000);
        await logUsage(db, { provider, model, pack_id, kind: 'repair', usage: rres.usage, ok: true, actor });
        const fixed = parseQuestions(rres.text);
        // Re-validate the fixes AGAINST the items we're keeping — a "fix" must not collide with a
        // question that already passed in the same batch.
        const goodOnes = checked.filter((c) => c.result.ok);
        const seed = [
          ...(existing || []),
          ...goodOnes.map((c) => ({ template: c.q.template, answer: c.q.answer, source: 'batch' })),
        ];
        const refixed = validateList(fixed, seed);
        repaired = refixed.filter((c) => c.result.ok).length;
        checked = [...goodOnes, ...refixed];
      } catch {
        // Repair is best-effort — if it fails we still queue the originals WITH their flags.
      }
    }

    // ---- Write to the REVIEW QUEUE (never to pm_questions) ----
    const batch_id = crypto.randomUUID();
    const rows = checked.map((c) => ({
      batch_id,
      pack_id,
      template: String(c.q.template || '').trim(),
      answer: String(c.q.answer || '').toUpperCase().trim(),
      alt_answer: String(c.q.alt_answer || '').toUpperCase().trim() || null,
      frame_slots: c.q.frame_slots || null,
      target_level: tLevel,
      provider, model,
      status: 'pending',
      validation: c.result,
    })).filter((r) => r.template && r.answer);

    if (!rows.length) return json({ error: 'empty', message: 'The model returned nothing usable.', raw: raw.slice(0, 400) }, 502);

    const { error: insErr } = await db.from('pm_review_queue').insert(rows);
    if (insErr) throw insErr;

    // Audit + cost trail for the run.
    await logUsage(db, {
      provider, model, pack_id, batch_id, kind: 'generate',
      usage: genUsage, questions: rows.length, ok: true, actor,
    });

    const clean = rows.filter((r: any) => r.validation?.ok).length;
    return json({
      ok: true,
      batch_id,
      provider, model,
      generated: rows.length,
      clean,
      flagged: rows.length - clean,
      repaired,
      message: `${rows.length} question${rows.length === 1 ? '' : 's'} queued for review (${clean} clean, ${rows.length - clean} flagged).`,
    });
  } catch (e) {
    return json({ error: 'server_error', message: String(e).slice(0, 500) }, 500);
  }
});
