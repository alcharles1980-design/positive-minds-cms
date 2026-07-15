// pack-describe — generates structured pack descriptions via Anthropic.
// Requires ANTHROPIC_API_KEY secret. Auth required (authenticated users only).
//
// PROVENANCE: recovered verbatim from the LIVE deployment (project tytrmjjucqijzcrbwjfm,
// slug "pack-describe", version 1) — it was deployed but had never been committed to the repo.
// This file is the source of record for it now. Redeploy with:
//   supabase functions deploy pack-describe --project-ref tytrmjjucqijzcrbwjfm
import { createClient } from 'jsr:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) return json({ error: 'no_key', message: 'ANTHROPIC_API_KEY is not configured on the server.' }, 400);

  try {
    const { name, emoji, difficulty, words, templates } = await req.json();
    const prompt = `You are helping author a children's CBMT (Cognitive Bias Modification Therapy) word game for kids roughly aged 5–12. In this game, children fill in a missing word to complete a positive affirmation, choosing between two words that are BOTH positive.

Write a structured description for this content pack:
- Pack name: ${name}
- Theme emoji: ${emoji || ''}
- Difficulty: ${difficulty || 'basic'}
- Example affirmation sentences: ${templates || '(none yet)'}
- Words used: ${words || '(none yet)'}

Return ONLY a JSON object (no markdown, no preamble) with exactly these four string keys:
{
  "purpose": "1–2 sentences: what this pack is for and its developmental objective",
  "focus_areas": "a short comma-separated list of the key themes/skills it covers",
  "style_approach": "1–2 sentences on the tone and teaching approach",
  "example_objectives": "2–3 concrete example goals a child works toward, semicolon-separated"
}
Keep it warm, concrete, age-appropriate, and specific to this pack's theme.`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) { const t = await r.text(); return json({ error: 'api_error', message: t }, 502); }
    const data = await r.json();
    const text = (data.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(clean); } catch { return json({ error: 'parse_error', raw: text }, 502); }
    return json({ ok: true, ...parsed });
  } catch (e) {
    return json({ error: 'server_error', message: String(e) }, 500);
  }
});
