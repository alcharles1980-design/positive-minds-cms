// ============================================================
// Content Generator — builds a ready-to-paste AI prompt for creating
// a batch of questions in our exact format, based on the selected
// pack, levels, themes, output format, and options.
// ============================================================

const miniLink = { background: "none", border: "none", padding: "2px 4px", cursor: "pointer", color: C.brandInk, fontSize: 12, fontWeight: 700 };

// The standalone, reusable background document. Gives an AI the full "why" behind the game so
// it authors on-model content rather than pattern-matching. Paste once alongside any prompt.
const MASTER_CONTEXT = `# Positive Minds — Background & Authoring Context

## What this is
Positive Minds is a word game for children (roughly ages 5–12) built on **Cognitive Bias Modification Therapy (CBMT)**. The premise of CBMT is simple but powerful: the thoughts a child rehearses shape the thoughts that come automatically. By having children repeatedly complete warm, self-affirming sentences, the game gently trains a more positive, resilient internal voice — building the habit of thinking well of themselves and the world.

## The core mechanic
Each question is a short, first-person sentence with one word partly hidden — some of its letters are revealed and the rest are shown as blanks (e.g. "I feel PR_UD of the things I do"). The child chooses between **two words. Both are positive** — there is never a negative or "wrong feeling" option — and the child's job is to pick the word whose **spelling fits the revealed letters and the blank shape**. The primary word (the answer) spells into the pattern; the second word is another warm, positive word that does **not** fit those letters. This is a SPELLING / word-recognition puzzle, NOT a meaning test — both words can make sense in the sentence; the LETTERS are what decide which is correct. Example: shown "I feel PR_UD…", the options might be PROUD and GLAD — both lovely, but only PROUD spells into P-R-_-U-D.

## Why both words are positive (spelling decides, not meaning)
This is the therapeutic heart of the design and must never be broken. Every word on screen is something good, so even a wrong guess never rehearses a harmful thought. What makes it a real game is the SPELLING: only one word matches the letters revealed in the blank. The reliable way to make the second word clearly wrong is to give it a **different length** from the primary — a different-length word can never fit the fixed blanks at any level. Do NOT rely on meaning to separate them and do NOT use near-synonyms of the same length: if both could spell into the pattern, the puzzle has two answers. So "wrong" only ever means "that positive word isn't spelled the way the blanks are" — never "you had a bad feeling" or "you failed."

## Who the child is
Assume a child who may be shy, anxious, still building confidence, or simply learning emotional vocabulary. The tone is warm, safe, and encouraging — like a kind adult who believes in them. Never clinical, never scary, never shaming. Nothing that references the child doing something wrong, being in danger, or failing. Language is simple and concrete; words are ones a child that age would recognise and be able to spell.

## Developmental progression (levels)
Content spans developmental levels, from very simple self-affirmations for the youngest ("I am {blank}" → HAPPY / GLAD) up to more nuanced emotional regulation for older children ("I can stay {blank} even when things feel unfair" → CALM / STEADY). Early levels use short, common words and the simplest feelings (confidence, kindness, happiness). Later levels introduce resilience, gratitude, empathy, moral reasoning, and self-regulation. The **game itself** controls how much of the word is hidden at each level — so an author does not need to vary the blank's difficulty, only to write sentences and word-pairs appropriate to the level's theme and age.

## Themes worth covering
Confidence and self-worth · kindness and caring for others · courage and trying new things · honesty · friendship and belonging · gratitude · patience · resilience and coping with hard feelings · respect · empathy · calm and self-regulation · hope and optimism. Each pack usually centres on one theme.

## What makes a GOOD question
- A warm, natural, first-person sentence ("I am…", "I feel…", "Being…", "I can…").
- Exactly one {blank}, placed where a feeling/quality word belongs.
- Two positive answer words that BOTH fit naturally and are genuinely age-appropriate.
- Answer words: single words, uppercase, spellable, common for the age.
- Emotionally true — a child could mean it and feel good saying it.

## What to AVOID
- Any negative, frightening, sad, or clinical framing.
- Any implication the child did something wrong or is at fault.
- Obscure or hard-to-spell words; multi-word answers.
- Two words where one is clearly better than the other (both should be valid).
- Repeating a question the pack already covers (see the "already covered" list when provided).

## Optional: frame words
Some sentences include a second braced word besides {blank} — e.g. "…when things are {hard}". These "frame words" are NOT guessed; they exist so the sentence can be varied for freshness or made gently more advanced at higher levels (hard → difficult → challenging). They are always neutral-to-mild and never undo the positivity of the sentence.

Keep all of the above in mind when authoring. The goal is not just correct puzzles — it is small, repeated moments that leave a child feeling a little braver, kinder, and more capable.`;

// Output-format templates. Each returns the instruction text + a concrete example
// so the AI knows precisely what to emit. Import-ready formats mirror BulkImport.
const OUTPUT_FORMATS = {
  json: {
    label: "JSON (import-ready)",
    hint: "A JSON array — paste straight into Bulk import.",
    instruct: (withFrames) => withFrames
      ? `Return ONLY a JSON array (no prose, no markdown fences). Each item:
{
  "template": "sentence with {blank} for the guess word, and optional {token} words to vary",
  "answer": "PRIMARYWORD",
  "alt_answer": "SECONDWORD",
  "frame_slots": {
    "token": { "pool": ["word1","word2","word3"], "byLevel": { "7": "word1", "8": "word2" } }
  }
}
Omit "frame_slots" for questions with no swappable words.`
      : `Return ONLY a JSON array (no prose, no markdown fences). Each item:
{ "template": "sentence with {blank} where the guess word goes", "answer": "PRIMARYWORD", "alt_answer": "SECONDWORD" }`,
    example: (withFrames) => withFrames
      ? `[
  {
    "template": "I stay {blank} even when things are {hard}.",
    "answer": "CALM",
    "alt_answer": "CENTERED",
    "frame_slots": { "hard": { "pool": ["hard","difficult","stressful","challenging"], "byLevel": { "7":"difficult","8":"stressful","9":"challenging" } } }
  },
  { "template": "I am {blank} when I try new things.", "answer": "BRAVE", "alt_answer": "BOLD" }
]`
      : `[
  { "template": "I am {blank} when I try new things.", "answer": "BRAVE", "alt_answer": "BOLD" },
  { "template": "Being {blank} helps me make friends.", "answer": "KIND", "alt_answer": "CARING" }
]`,
  },
  pipe: {
    label: "Pipe (simple)",
    hint: "One line each: sentence | ANSWER | ALT. Easiest to read; import-ready.",
    instruct: () => `Return ONLY plain lines, one question per line, in this exact shape:
Sentence with {blank} | PRIMARYWORD | SECONDWORD
No numbering, no bullet points, no extra prose.`,
    example: () => `I am {blank} when I try new things. | BRAVE | BOLD
Being {blank} helps me make friends. | KIND | CARING
It feels good to be {blank} to others. | HELPFUL | HONEST`,
  },
  table: {
    label: "Table (review-friendly)",
    hint: "A markdown table you can eyeball before converting.",
    instruct: () => `Return ONLY a markdown table with columns: Sentence | Primary word | Second word.
The Sentence must contain {blank} where the guess word goes.`,
    example: () => `| Sentence | Primary word | Second word |
|---|---|---|
| I am {blank} when I try new things. | BRAVE | BOLD |
| Being {blank} helps me make friends. | KIND | CARING |`,
  },
};

// The core: assemble the full prompt from the chosen options.
// Build a compact "already covered — avoid these" section from the pack's existing questions,
// so the AI steers away from duplicates. We give the answer words (the concepts already used)
// plus a short signature of each sentence, rather than the full objects, to keep it light.
function buildAvoidList(existingQuestions) {
  const qs = existingQuestions || [];
  if (!qs.length) return "";
  const answers = new Set();
  const sigs = [];
  for (const q of qs) {
    if (q.answer) answers.add(q.answer.toUpperCase());
    if (q.alt_answer) answers.add(q.alt_answer.toUpperCase());
    // A readable signature: the sentence with the blank shown as ___, trimmed.
    const sig = (q.template || "").replace(/\{blank\}/g, "___").replace(/\{([a-zA-Z][\w-]*)\}/g, "$1").trim();
    if (sig) sigs.push(sig);
  }
  const lines = [];
  lines.push(`ALREADY COVERED — DO NOT REPEAT THESE:`);
  lines.push(`This pack already contains ${qs.length} question${qs.length === 1 ? "" : "s"}. Do NOT reproduce any of them, and avoid trivial rewordings. Produce genuinely new sentences and, where possible, fresh answer words.`);
  if (answers.size) lines.push(`Answer words already used (prefer different words): ${[...answers].sort().join(", ")}.`);
  if (sigs.length) {
    // Cap the sentence list so a large pack doesn't bloat the prompt or bury the instructions.
    // The answer-word list above is the compact, high-value dedup signal; sentences are a bonus.
    const SIG_CAP = 120;
    const shown = sigs.slice(0, SIG_CAP);
    lines.push(`Existing sentences${sigs.length > SIG_CAP ? ` (showing ${SIG_CAP} of ${sigs.length})` : ""} (do not duplicate these):`);
    for (const s of shown) lines.push(`- ${s}`);
    if (sigs.length > SIG_CAP) lines.push(`- …and ${sigs.length - SIG_CAP} more. Avoid close variations of any sentence in this pack.`);
  }
  return lines.join("\n");
}

function buildGeneratorPrompt({ pack, levels, selectedLevels, themes, count, format, withFrames, extraNotes, existingQuestions, includeContext, avoidExisting }) {
  const fmt = OUTPUT_FORMATS[format] || OUTPUT_FORMATS.json;
  const levelDefs = (levels || []).filter(l => selectedLevels.includes(l.level)).sort((a, b) => a.level - b.level);

  const lines = [];
  lines.push(`You are helping author content for "Positive Minds", a Cognitive Bias Modification Therapy (CBMT) word game for children roughly aged 5–12.`);
  lines.push("");
  if (includeContext) {
    lines.push(`BACKGROUND (why this matters): CBMT works on the principle that the thoughts a child rehearses become the thoughts that come automatically. Every question shows a warm, first-person sentence with one word partly hidden (some letters shown, the rest blank) and offers TWO positive words — so even a wrong guess never rehearses a harmful thought. It is a SPELLING puzzle: the child picks the word whose letters fit the revealed pattern. Only the primary word spells into the blanks; the other is positive too but does not match the letters. The tone is warm and encouraging, never shaming; a wrong pick just means "that word isn't spelled like the blanks", never that the child failed. Words are simple, common, and spellable for the age.`);
    lines.push("");
  }
  lines.push(`THE GAME MECHANIC: each question is a short, positive first-person sentence with one word partly hidden — some letters revealed, the rest shown as blanks. The child picks, from TWO positive words, the one whose SPELLING fits the revealed letters + blank shape. BOTH words are positive (never a negative option); only the PRIMARY word spells into the pattern. The second word is positive too but must NOT fit the letters. This is a spelling/word-recognition puzzle, NOT a meaning test. Write the target word normally; the {blank} token marks where it goes.`);
  lines.push("");

  // Pack context
  lines.push(`PACK: ${pack?.name || "(unspecified)"}`);
  if (pack?.emoji) lines.push(`Theme emoji: ${pack.emoji}`);
  if (themes?.trim()) lines.push(`Focus / themes to cover: ${themes.trim()}`);
  if (pack?.purpose) lines.push(`Pack purpose: ${pack.purpose}`);
  if (pack?.style_approach) lines.push(`Tone & approach: ${pack.style_approach}`);
  lines.push("");

  // Level guidance
  if (levelDefs.length) {
    lines.push(`TARGET LEVELS: write questions suitable across these developmental levels:`);
    for (const l of levelDefs) {
      const bits = [`Level ${l.level}${l.name ? ` (${l.name})` : ""}`];
      if (l.theme) bits.push(l.theme);
      if (l.age_hint) bits.push(`ages ${l.age_hint}`);
      lines.push(`- ${bits.join(" — ")}`);
      // Per-level word constraints so generated words actually fit the level's rules.
      const wc = [];
      if (l.min_word_len && l.max_word_len) wc.push(`answer words ${l.min_word_len}–${l.max_word_len} letters long`);
      else if (l.min_word_len) wc.push(`answer words at least ${l.min_word_len} letters`);
      else if (l.max_word_len) wc.push(`answer words at most ${l.max_word_len} letters`);
      if (l.allow_multiword) wc.push(`two-word answers or short phrases are allowed`);
      else wc.push(`single words only`);
      if (l.vocab_rule) wc.push(l.vocab_rule);
      if (wc.length) lines.push(`    · words for L${l.level}: ${wc.join("; ")}.`);
      // Remind that BOTH answer words must obey the band AND differ in length from each other.
      if (l.min_word_len || l.max_word_len) lines.push(`    · both the primary AND the alternate for L${l.level} must fall in that length band, while still differing in length from EACH OTHER so only one fits the blanks.`);
    }
    lines.push(`The same question can work across levels; the game itself controls how much of the word is hidden per level. Focus on writing sentences and word-pairs that match each level's theme, age, and the word constraints above.`);
    lines.push("");
  }

  // Rules
  lines.push(`RULES (important):`);
  lines.push(`1. Every sentence must contain exactly one {blank}.`);
  lines.push(`2. Provide TWO answer words, both genuinely positive and age-appropriate. The FIRST (primary) word is the correct answer — it is the word the sentence is really about. The SECOND word must be another positive word whose SPELLING does NOT fit the primary's blank pattern — the simplest reliable way is to make it a DIFFERENT LENGTH from the primary (a different-length word can never match the fixed blanks at any level). Do NOT make them the same length near-synonyms; if both could spell into the pattern the question has two answers. Example: primary PROUD (5) with alternate GLAD (4) — both positive, different lengths, so only PROUD fits "PR_UD".`);
  const anyMultiword = levelDefs.some(l => l.allow_multiword);
  lines.push(anyMultiword
    ? `3. Answer words are UPPERCASE, no punctuation. Single words by default; where a level's rules allow it, a two-word answer or short phrase is fine (still make the primary and alternate different lengths so only one fits the blanks). Prefer words a child at that level would know.`
    : `3. Answer words are single words, UPPERCASE, no punctuation. Prefer common words a child would know; keep them short enough to spell.`);
  lines.push(`4. Sentences are warm, simple, first-person ("I am…", "I feel…", "Being…"), and self-affirming.`);
  lines.push(`5. Avoid anything scary, negative, clinical, or that references the child doing something wrong.`);
  lines.push(`6. No duplicates; vary the sentence structure.`);

  if (withFrames) {
    lines.push("");
    lines.push(`FRAME WORDS (optional variation): besides {blank}, a sentence may include other words in braces, like {hard}, that are NOT guessed but can be swapped for variety. For any such word, provide a "frame_slots" entry: a "pool" of positive-appropriate alternatives, and optionally a "byLevel" map pinning a specific alternative to specific levels (useful so higher levels feel more advanced). Example: "…when things are {hard}" with pool ["hard","difficult","stressful","challenging"]. Only add frame words where they genuinely add value; most questions won't need them.`);
  }

  if (extraNotes?.trim()) {
    lines.push("");
    lines.push(`ADDITIONAL INSTRUCTIONS: ${extraNotes.trim()}`);
  }

  if (avoidExisting) {
    const avoid = buildAvoidList(existingQuestions);
    if (avoid) { lines.push(""); lines.push(avoid); }
  }

  lines.push("");
  lines.push(`HOW MANY: produce ${count} questions.`);
  lines.push("");
  lines.push(`OUTPUT FORMAT:`);
  lines.push(fmt.instruct(withFrames));
  lines.push("");
  lines.push(`EXAMPLE OF THE EXACT OUTPUT SHAPE:`);
  lines.push(fmt.example(withFrames));

  return lines.join("\n");
}

function GeneratorView({ packs, levels }) {
  // HOW to run it. The options are identical either way — the method must not change what you're
  // allowed to ask for. (Previously the API path lived in Settings as a stripped-down panel with no
  // themes and no frame words: a poor relation of the manual one, for no good reason.)
  const [method, setMethod] = useState("prompt");

  // Is an API key actually usable? If not, the API option is offered but disabled with a reason,
  // rather than silently failing when you press Generate.
  const keyState = useAsync(() => rpc("pm_ai_status").catch(() => []), []);
  const providers = keyState.data || [];
  const settingsState = useAsync(() => rest("pm_ai_settings?id=eq.1&limit=1").then(r => (r.data || [])[0] || null), []);
  const activeProvider = settingsState.data?.active_provider || "anthropic";
  const active = providers.find(p => p.provider === activeProvider);
  const keyReady = !!(active?.configured && active?.enabled !== false);

  // Default to whichever method can actually run — but ONCE, and never after the user has chosen.
  // (Without the ref this is only correct by accident: it works because keyReady happens not to
  // change again. If it ever did — a key added in another tab, a realtime refresh — the effect would
  // yank the user out of the mode they deliberately picked.)
  const methodChosen = useRef(false);
  useEffect(() => {
    if (!methodChosen.current && keyReady) setMethod("api");
  }, [keyReady]);
  const chooseMethod = (m) => { methodChosen.current = true; setMethod(m); };

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const realLevels = (levels && levels.length) ? levels : Array.from({ length: 10 }, (_, i) => ({ level: i + 1, name: "" }));
  const [packId, setPackId] = useState("");
  const pack = (packs || []).find(p => p.id === packId) || null;

  const [selectedLevels, setSelectedLevels] = useState([]);
  const [themes, setThemes] = useState("");
  const [count, setCount] = useState(15);
  const [format, setFormat] = useState("json");
  const [withFrames, setWithFrames] = useState(false);
  const [extraNotes, setExtraNotes] = useState("");
  const [copied, setCopied] = useState(false);
  const [includeContext, setIncludeContext] = useState(true);
  const [avoidExisting, setAvoidExisting] = useState(true);
  const [existingQuestions, setExistingQuestions] = useState([]);
  const [loadingQs, setLoadingQs] = useState(false);
  const [showContextDoc, setShowContextDoc] = useState(false);
  const [ctxCopied, setCtxCopied] = useState(false);

  // When a pack is chosen, pre-fill themes from its focus areas (editable) and load its
  // existing questions so we can build an "avoid these" list. A ref guards against
  // out-of-order responses when the user switches packs quickly.
  const latestPackReq = useRef(null);
  const applyPack = async (id) => {
    setPackId(id);
    const p = (packs || []).find(x => x.id === id);
    if (p) {
      setThemes(p.focus_areas || p.purpose || "");
      if (selectedLevels.length === 0 && p.level) setSelectedLevels([p.level]);
    }
    setExistingQuestions([]);
    latestPackReq.current = id;
    if (!id) { setLoadingQs(false); return; }
    setLoadingQs(true);
    try { const qs = await db.allQuestionsForPack(id); if (latestPackReq.current === id) setExistingQuestions(qs || []); }
    catch { if (latestPackReq.current === id) setExistingQuestions([]); }
    finally { if (latestPackReq.current === id) setLoadingQs(false); }
  };

  const toggleLevel = (lvl) => setSelectedLevels(s => s.includes(lvl) ? s.filter(x => x !== lvl) : [...s, lvl].sort((a, b) => a - b));
  const allLevels = () => setSelectedLevels(realLevels.map(l => l.level));
  const noLevels = () => setSelectedLevels([]);

  const prompt = useMemo(
    () => buildGeneratorPrompt({ pack, levels: realLevels, selectedLevels, themes, count, format, withFrames, extraNotes, existingQuestions, includeContext, avoidExisting }),
    [pack, realLevels, selectedLevels, themes, count, format, withFrames, extraNotes, existingQuestions, includeContext, avoidExisting]
  );

  const copyContextDoc = async () => {
    try { await navigator.clipboard.writeText(MASTER_CONTEXT); setCtxCopied(true); setTimeout(() => setCtxCopied(false), 1800); notify("Context document copied"); }
    catch { notify("Couldn't copy — select and copy manually", { kind: "error" }); }
  };

  // Run it through the API. Uses the SAME options as the prompt path — that is the whole point.
  const runApi = async () => {
    if (!packId) { notify("Pick a pack first", "error"); return; }
    setRunning(true); setResult(null);
    try {
      const res = await callFn("generate-questions", {
        pack_id: packId,
        // The API takes ONE target level. If several are ticked, use the lowest — the level system
        // renders every other level from the same question anyway, so nothing is lost.
        target_level: selectedLevels.length ? Math.min(...selectedLevels) : null,
        count: Math.min(30, Math.max(1, parseInt(count) || 10)),
        notes: extraNotes.trim(),
        themes: themes.trim(),
        with_frames: !!withFrames,
      });
      if (res?.error === "rate_limited") { notify(res.message || "Rate limit reached", "error"); return; }
      if (res?.error === "no_key") { notify("No API key saved — add one in AI Settings", "error"); return; }
      if (res?.error === "provider_disabled") { notify(res.message || "That provider is turned off", "error"); return; }
      if (res?.error) throw new Error(res.message || res.error);
      setResult(res);
      notify(res.message || "Queued for review");
    } catch (e) {
      notify(friendlyError(0, String(e?.message || e)), "error");
    } finally { setRunning(false); }
  };

  const copyPrompt = async () => {    try { await navigator.clipboard.writeText(prompt); setCopied(true); setTimeout(() => setCopied(false), 1800); notify("Prompt copied"); }
    catch { notify("Couldn't copy — select and copy manually", { kind: "error" }); }
  };

  return (
    <div>
      <div style={{ marginBottom: S.lg }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 800, color: C.ink, letterSpacing: -0.3 }}>Generate questions</h1>
        <p className="pm-prose" style={{ margin: "4px 0 0", color: C.sub, fontSize: 14.5, lineHeight: 1.5 }}>
          Describe what you want, then either let your own AI key write it, or copy a prompt to paste
          into any AI tool. Either way it lands in <b>AI Review</b> for your approval first.
        </p>
      </div>

      {/* HOW to run it. The options below are the SAME either way — the method should not change
          what you're allowed to ask for. (Before this, API generation was a stripped-down panel
          buried in Settings, missing themes and frame words entirely.) */}
      <div className="pm-readable" style={{ display: "flex", gap: 10, marginBottom: S.lg, flexWrap: "wrap" }}>
        {[
          { id: "api", title: "Use my API key", sub: keyReady ? "Writes them for you, straight into review" : "No key saved yet", icon: "⚡", disabled: !keyReady },
          { id: "prompt", title: "Copy a prompt", sub: "Paste into ChatGPT, Claude, anything", icon: "⎘", disabled: false },
        ].map(m => {
          const on = method === m.id;
          return (
            <button key={m.id} onClick={() => !m.disabled && chooseMethod(m.id)} disabled={m.disabled}
              aria-pressed={on} aria-label={`${m.title} — ${m.sub}`}
              style={{ flex: "1 1 240px", textAlign: "left", padding: "13px 16px", borderRadius: R.lg,
                cursor: m.disabled ? "not-allowed" : "pointer", fontFamily: "inherit",
                border: "2px solid " + (on ? C.brand : C.line),
                background: on ? C.brandSoft : C.panel,
                opacity: m.disabled ? 0.55 : 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span style={{ fontSize: 17 }}>{m.icon}</span>
                <span style={{ fontSize: 14.5, fontWeight: 800, color: on ? C.brandInk : C.ink }}>{m.title}</span>
              </div>
              <div style={{ fontSize: 12.5, color: on ? C.brandInk : C.sub, marginTop: 3, opacity: .85 }}>{m.sub}</div>
            </button>
          );
        })}
      </div>

      {method === "api" && !keyReady && (
        <div className="pm-readable" style={{ background: C.warn + "12", border: "1px solid " + C.warn + "44",
          borderRadius: R.md, padding: "11px 14px", marginBottom: S.lg, fontSize: 13, color: C.ink2, lineHeight: 1.55 }}>
          You haven't saved an API key yet, so this option can't run. Add one in <b>AI Settings</b> — or
          use <b>Copy a prompt</b>, which works with any AI tool and needs no key.
        </div>
      )}

      <div className="pm-gen-grid" style={{ display: "grid", gridTemplateColumns: "minmax(320px, 420px) 1fr", gap: S.lg, alignItems: "start" }}>
        {/* Controls */}
        <div style={{ display: "grid", gap: S.lg }}>
          <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg, display: "grid", gap: S.md }}>
            <Field label="Pack" hint="Pre-fills themes and context from the pack">
              <Select value={packId} onChange={(e) => applyPack(e.target.value)}>
                <option value="">Choose a pack…</option>
                {(packs || []).map(p => <option key={p.id} value={p.id}>{p.emoji ? p.emoji + " " : ""}{p.name}</option>)}
              </Select>
            </Field>

            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: C.ink2 }}>Levels to target</span>
                <div style={{ flex: 1 }} />
                <button type="button" onClick={allLevels} style={miniLink}>All</button>
                <button type="button" onClick={noLevels} style={miniLink}>None</button>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {realLevels.map(l => {
                  const on = selectedLevels.includes(l.level);
                  return (
                    <button key={l.level} type="button" onClick={() => toggleLevel(l.level)} title={l.name || `Level ${l.level}`}
                      style={{ padding: "5px 11px", borderRadius: R.pill, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
                        border: "1px solid " + (on ? (l.color || C.brand) : C.line),
                        background: on ? (l.color || C.brand) + "1E" : "transparent",
                        color: on ? (l.color || C.brandInk) : C.sub }}>
                      L{l.level}
                    </button>
                  );
                })}
              </div>
              {selectedLevels.length === 0 && <div style={{ fontSize: 12, color: C.faint, marginTop: 6 }}>No levels selected — the prompt will target the pack generally.</div>}
            </div>

            <Field label="Themes / focus" hint="What these questions should be about — edit freely">
              <Textarea value={themes} onChange={(e) => setThemes(e.target.value)} rows={2} placeholder="e.g. self-worth, trying new things, personal strengths" />
            </Field>

            {/* "Output format" only means something for the copy-a-prompt path — the API always
                returns structured JSON. Showing it in API mode would be a control that does nothing. */}
            <div className={method === "prompt" ? "pm-form-2" : ""}>
              <Field label="How many">
                <Input type="number" min={1} max={100} value={count} aria-label="How many questions" onChange={(e) => setCount(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))} />
              </Field>
              {method === "prompt" && (
                <Field label="Output format" hint={OUTPUT_FORMATS[format]?.hint}>
                  <Select value={format} onChange={(e) => setFormat(e.target.value)}>
                    {Object.entries(OUTPUT_FORMATS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </Select>
                </Field>
              )}
            </div>

            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, cursor: "pointer" }}>
              <input type="checkbox" checked={withFrames} onChange={(e) => setWithFrames(e.target.checked)} style={{ width: 16, height: 16, accentColor: C.brand, marginTop: 2 }} />
              <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Include frame-word variations
                <div style={{ fontSize: 12, color: C.sub, fontWeight: 500, marginTop: 1 }}>Teach the AI the swappable {"{token}"} system so higher levels can differ.</div>
              </span>
            </label>

            {method === "prompt" && (
            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, cursor: "pointer" }}>
              <input type="checkbox" checked={includeContext} onChange={(e) => setIncludeContext(e.target.checked)} style={{ width: 16, height: 16, accentColor: C.brand, marginTop: 2 }} />
              <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Include background context
                <div style={{ fontSize: 12, color: C.sub, fontWeight: 500, marginTop: 1 }}>Prepend a short "why this matters" so the AI writes on-model. (Full doc below.)</div>
              </span>
            </label>
            )}

            {method === "prompt" && (
            <label style={{ display: "flex", alignItems: "flex-start", gap: 9, cursor: pack ? "pointer" : "not-allowed", opacity: pack ? 1 : 0.55 }}>
              <input type="checkbox" checked={avoidExisting} disabled={!pack} onChange={(e) => setAvoidExisting(e.target.checked)} style={{ width: 16, height: 16, accentColor: C.brand, marginTop: 2 }} />
              <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Avoid existing questions
                <div style={{ fontSize: 12, color: C.sub, fontWeight: 500, marginTop: 1 }}>
                  {!pack ? "Pick a pack first." : loadingQs ? "Loading this pack's questions…" : `Tell the AI not to repeat the ${existingQuestions.length} question${existingQuestions.length === 1 ? "" : "s"} already in this pack.`}
                </div>
              </span>
            </label>
            )}

            {method === "api" && (
              <div style={{ fontSize: 12.5, color: C.faint, lineHeight: 1.55, paddingTop: 2 }}>
                The API route always avoids words already used and always writes on-model — no need to
                ask for either.
              </div>
            )}

            <Field label="Extra instructions" hint="Optional — anything specific to add to the prompt">
              <Textarea value={extraNotes} onChange={(e) => setExtraNotes(e.target.value)} rows={2} placeholder="e.g. avoid words with silent letters; keep answers under 6 letters" />
            </Field>
          </div>

          {/* Master context document — standalone, reusable */}
          <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, overflow: "hidden" }}>
            <button type="button" onClick={() => setShowContextDoc(v => !v)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: S.lg, background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>
              <span style={{ fontSize: 14, fontWeight: 800, color: C.ink }}>{showContextDoc ? "▾" : "▸"} Master context document</span>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: C.faint }}>reusable</span>
            </button>
            {showContextDoc && (
              <div style={{ padding: `0 ${S.lg}px ${S.lg}px`, display: "grid", gap: S.md }}>
                <div style={{ fontSize: 12.5, color: C.sub, lineHeight: 1.5 }}>
                  The full background on the game's purpose and CBMT model. Paste this once at the top of a fresh AI chat, then paste the generated prompt after it — the AI keeps the context for every batch you ask for in that chat.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <Btn size="sm" onClick={copyContextDoc} icon={ctxCopied ? "✓" : "⧉"}>{ctxCopied ? "Copied" : "Copy document"}</Btn>
                </div>
                <Textarea readOnly value={MASTER_CONTEXT} rows={12} aria-label="Master context (read only)" onFocus={(e) => e.target.select()}
                  style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, lineHeight: 1.55, background: C.bg, resize: "vertical" }} />
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN — this is the ONLY part that differs by method. */}
        {method === "api" ? (
          <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg,
            padding: S.lg, position: "sticky", top: S.lg, display: "grid", gap: S.md }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: C.ink }}>Generate with your API key</div>
              <div style={{ fontSize: 13, color: C.sub, marginTop: 3, lineHeight: 1.55 }}>
                {active ? <>Using <b>{active.model || activeProvider}</b>.</> : null} Each question is checked
                against the real game engine, then waits in <b>AI Review</b> for you to approve.
              </div>
            </div>

            {/* A plain summary of what is about to happen — no surprises. */}
            <div style={{ background: C.bg, borderRadius: R.md, padding: "12px 14px", fontSize: 13, color: C.ink2, lineHeight: 1.7 }}>
              <div><b>{count}</b> question{count === 1 ? "" : "s"}</div>
              <div>for <b>{pack ? `${pack.emoji || ""} ${pack.name}` : "— pick a pack"}</b></div>
              <div>at <b>{selectedLevels.length ? `level${selectedLevels.length > 1 ? "s" : ""} ${selectedLevels.join(", ")}` : `the pack's level`}</b></div>
              {themes.trim() && <div>on <b>{themes.trim()}</b></div>}
              {withFrames && <div>with frame words</div>}
            </div>

            <Btn onClick={runApi} disabled={running || !packId || !keyReady}>
              {running ? "Generating…" : `Generate ${count} question${count === 1 ? "" : "s"}`}
            </Btn>

            {result && (
              <>
                <div style={{ background: C.ok + "10", border: "1px solid " + C.ok + "44", borderRadius: R.md,
                  padding: "12px 14px", fontSize: 13, color: C.ink, lineHeight: 1.6 }}>
                  <b>{result.generated}</b> question{result.generated === 1 ? "" : "s"} queued —{" "}
                  <b style={{ color: C.ok }}>{result.clean}</b> passed every check
                  {result.flagged > 0 && <> · <b style={{ color: C.danger }}>{result.flagged}</b> flagged</>}
                  {result.repaired > 0 && <> · {result.repaired} auto-fixed</>}.
                  <div style={{ marginTop: 6 }}>Go to <b>AI Review</b> to approve them.</div>
                </div>
                {result.warning && (
                  <div style={{ background: C.warn + "12", border: "1px solid " + C.warn + "44", borderRadius: R.md,
                    padding: "11px 14px", fontSize: 12.5, color: C.ink2, lineHeight: 1.55 }}>
                    <b style={{ color: C.warn }}>Heads up.</b> {result.warning}
                  </div>
                )}
              </>
            )}

            <div style={{ fontSize: 12, color: C.faint, lineHeight: 1.5 }}>
              Nothing reaches a pack until you approve it. Model, temperature and spend limits are in{" "}
              <b>AI Settings</b>.
            </div>
          </div>
        ) : (
        /* Prompt output */
        <div style={{ background: C.panel, border: "1px solid " + C.line, borderRadius: R.lg, overflow: "hidden", position: "sticky", top: S.lg }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: `${S.md}px ${S.lg}px`, borderBottom: "1px solid " + C.line }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: C.ink }}>Generated prompt</span>
            <span style={{ fontSize: 12, color: C.faint }}>{prompt.length.toLocaleString()} chars</span>
            <div style={{ flex: 1 }} />
            <Btn size="sm" onClick={copyPrompt} icon={copied ? "✓" : "⧉"}>{copied ? "Copied" : "Copy"}</Btn>
          </div>
          <Textarea readOnly value={prompt} rows={22} aria-label="Generated prompt (read only)"
            onFocus={(e) => e.target.select()}
            style={{ border: "none", borderRadius: 0, fontFamily: "ui-monospace, monospace", fontSize: 12.5, lineHeight: 1.55, resize: "vertical", background: C.bg }} />
          <div style={{ padding: `${S.sm + 2}px ${S.lg}px`, borderTop: "1px solid " + C.line, fontSize: 12.5, color: C.sub, lineHeight: 1.5 }}>
            Paste this into your AI tool, then bring the result back via <b>a pack → Import</b>{format === "table" ? " (convert the table to pipe/JSON first)" : ""}.
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
