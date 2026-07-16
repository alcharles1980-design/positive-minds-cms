// ============================================================
// Editors
// ============================================================
const EMOJIS = ["💪","😊","🧘","🎯","🎓","💡","🛡️","🤝","🫶","🌟","🗣️","👨‍👩‍👧","🌈","🕊️","❤️","🌱","✨","🧠","🔆","🦋","🌞","🏆","🎨","🚀"];
const COLORS = ["#F39C12","#E84393","#00B894","#0984E3","#6C4CE0","#FDCB6E","#D63031","#00CEC9","#E17055","#FAB1A0","#74B9FF","#A29BFE","#55EFC4","#81ECEC"];
const PACK_TAG_SUGGESTIONS = ["emotions","confidence","social","calm","focus","resilience","gratitude","school-ready","ages-5-7","ages-8-10","starter","advanced"];

function PackEditor({ pack, levels, onSave, onClose }) {
  const isNew = !pack?.id;
  const [f, setF] = useState({
    name: pack?.name || "", slug: pack?.slug || "", emoji: pack?.emoji || "💪",
    description: pack?.description || "", color: pack?.color || C.brand,
    difficulty: pack?.difficulty || "basic", status: pack?.status || "draft", is_custom: pack?.is_custom || false,
    level: pack?.level || 1,
    purpose: pack?.purpose || "", focus_areas: pack?.focus_areas || "",
    style_approach: pack?.style_approach || "", example_objectives: pack?.example_objectives || "",
    tags: pack?.tags || [],
  });
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState({});
  const [aiBusy, setAiBusy] = useState(false);
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));

  const suggestDetails = async () => {
    setAiBusy(true);
    try {
      const words = pack?.id ? "" : ""; // words come from questions; the fn can work from name/theme alone
      const res = await fetch(`${CFG.url}/functions/v1/pack-describe`, {
        method: "POST",
        headers: { apikey: CFG.key, Authorization: `Bearer ${session.token || CFG.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: f.name, emoji: f.emoji, difficulty: f.difficulty, words, templates: "" }),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        notify(d.error === "no_key" ? "AI drafting isn't configured yet (server needs an Anthropic API key)." : "Couldn't draft details: " + (d.message || res.status), { kind: "error" });
        return;
      }
      setF(p => ({ ...p, purpose: d.purpose || p.purpose, focus_areas: d.focus_areas || p.focus_areas, style_approach: d.style_approach || p.style_approach, example_objectives: d.example_objectives || p.example_objectives }));
      notify("Draft filled in — review and edit as needed");
    } catch (e) { notify("Couldn't reach the drafting service", { kind: "error" }); }
    finally { setAiBusy(false); }
  };

  const submit = async () => {
    const e = {};
    if (!f.name.trim()) e.name = "Give the pack a name.";
    if (!f.slug.trim()) e.slug = "Slug can't be empty.";
    setErrs(e); if (Object.keys(e).length) return;
    setBusy(true);
    try { await onSave(f, pack?.id); onClose(); }
    catch (err) { setErrs({ form: err.message }); setBusy(false); }
  };
  useHotkey("mod+enter", submit, true);

  return (
    <>
      <ModalHead emoji={f.emoji} title={isNew ? "New pack" : "Edit pack"} subtitle={isNew ? "Add a themed category to the library" : f.name} id="pm-pack-title" />
      <div style={{ padding: S.xl + 2, display: "grid", gap: S.lg + 2, maxHeight: "62vh", overflowY: "auto" }}>
        <Field label="Pack name" error={errs.name}>
          <Input value={f.name} onChange={(e) => { set("name", e.target.value); if (!slugTouched) set("slug", slugify(e.target.value)); }} placeholder="e.g. Confidence Pack" autoFocus />
        </Field>
        <div className="pm-form-2">
          <Field label="Slug" hint="URL-safe id used by the game" error={errs.slug}>
            <Input value={f.slug} onChange={(e) => { setSlugTouched(true); set("slug", slugify(e.target.value)); }} placeholder="confidence" />
          </Field>
          <Field label="Difficulty">
            <Select value={f.difficulty} onChange={(e) => set("difficulty", e.target.value)}>
              <option value="basic">Basic</option><option value="advanced">Advanced</option><option value="mixed">Mixed</option>
            </Select>
          </Field>
        </div>
        <Field label="Default level" hint="The starting level for questions in this pack (each question can override)">
          <Select value={f.level} onChange={(e) => set("level", parseInt(e.target.value))}>
            {(levels && levels.length ? levels : Array.from({ length: 10 }, (_, i) => ({ level: i + 1, name: "" }))).map(l => (
              <option key={l.level} value={l.level}>Level {l.level}{l.name ? ` — ${l.name}` : ""}</option>
            ))}
          </Select>
        </Field>
        <Field label="Description" hint="Short blurb shown on the pack card">
          <Textarea value={f.description} onChange={(e) => set("description", e.target.value)} rows={2} placeholder="Believe in yourself and take pride in what you do." />
        </Field>

        {/* Structured pack description */}
        <div style={{ borderTop: "1px solid " + C.line, paddingTop: S.md, marginTop: 2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: S.sm }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: C.ink, letterSpacing: 0.2, textTransform: "uppercase" }}>Pack details</span>
            <span style={{ fontSize: 12, color: C.sub }}>· purpose, focus, approach & objectives</span>
            <div style={{ flex: 1 }} />
            <Btn variant="soft" size="sm" disabled={aiBusy || !f.name} onClick={suggestDetails} icon="✦">{aiBusy ? "Drafting…" : "AI draft"}</Btn>
          </div>
          <div style={{ display: "grid", gap: S.md }}>
            <Field label="Purpose" hint="What this pack is for — its objective">
              <Textarea value={f.purpose} onChange={(e) => set("purpose", e.target.value)} rows={2} placeholder="Help children build a stable sense of self-belief…" />
            </Field>
            <Field label="Focus areas" hint="Key themes and skills it covers">
              <Textarea value={f.focus_areas} onChange={(e) => set("focus_areas", e.target.value)} rows={2} placeholder="Self-worth, personal strengths, trying new things" />
            </Field>
            <Field label="Style & approach" hint="Tone and how it teaches">
              <Textarea value={f.style_approach} onChange={(e) => set("style_approach", e.target.value)} rows={2} placeholder="Warm and encouraging; every word choice is a positive trait…" />
            </Field>
            <Field label="Example objectives" hint="Concrete goals a child works toward">
              <Textarea value={f.example_objectives} onChange={(e) => set("example_objectives", e.target.value)} rows={2} placeholder="A child can name two of their own strengths; feels able to try something new…" />
            </Field>
          </div>
        </div>
        <Field label="Tags" hint="Enter or comma to add — for cross-cutting organization">
          <TagInput tags={f.tags} onChange={(t) => set("tags", t)} suggestions={PACK_TAG_SUGGESTIONS} />
        </Field>
        <Field label="Icon">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {EMOJIS.map(e => (
              <button key={e} onClick={() => set("emoji", e)} style={{ fontSize: 20, width: 40, height: 40, borderRadius: R.md, cursor: "pointer", border: "2px solid " + (f.emoji === e ? C.brand : C.line), background: f.emoji === e ? C.brandSoft : "#fff" }}>{e}</button>
            ))}
          </div>
        </Field>
        <Field label="Accent color">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {COLORS.map(c => (
              <button key={c} onClick={() => set("color", c)} title={c} style={{ width: 30, height: 30, borderRadius: R.sm, cursor: "pointer", background: c, border: "3px solid " + (f.color === c ? C.ink : "transparent"), boxShadow: f.color === c ? "0 0 0 2px #fff inset" : "none" }} />
            ))}
          </div>
        </Field>
        <div className="pm-form-2" style={{ alignItems: "end" }}>
          <Field label="Status">
            <Select value={f.status} onChange={(e) => set("status", e.target.value)}>
              <option value="draft">Draft (hidden from game)</option>
              <option value="published">Published (live)</option>
              <option value="archived">Archived</option>
            </Select>
          </Field>
          <label style={{ display: "flex", alignItems: "center", gap: 9, padding: "10px 0", cursor: "pointer" }}>
            <input type="checkbox" checked={f.is_custom} onChange={(e) => set("is_custom", e.target.checked)} style={{ width: 17, height: 17, accentColor: C.brand }} />
            <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Custom / AI-generated</span>
          </label>
        </div>
        {errs.form && <ErrorState error={errs.form} />}
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy}>{busy ? "Saving…" : isNew ? "Create pack" : "Save changes"}</Btn>
      </ModalFoot>
    </>
  );
}

// Editor for one frame-word slot: a pool of variations + optional per-level pins.
function FrameSlotEditor({ token, slot, setSlot, levels }) {
  const [showLevels, setShowLevels] = useState(false);
  const pool = slot.pool || [];
  const byLevel = slot.byLevel || {};
  const levelList = (levels && levels.length ? levels : Array.from({ length: 10 }, (_, i) => ({ level: i + 1, name: "" })));
  const pinnedCount = Object.values(byLevel).filter(v => v != null && v !== "").length;
  return (
    <div style={{ background: C.bg, borderRadius: R.md, padding: "12px 14px", display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <code style={{ background: C.brandSoft, color: C.brandInk, padding: "2px 8px", borderRadius: 6, fontSize: 13, fontWeight: 800 }}>{`{${token}}`}</code>
        <span style={{ fontSize: 12.5, color: C.sub }}>variations for this word</span>
      </div>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.faint, marginBottom: 5 }}>Pool of alternatives (the game varies among these)</div>
        <TagInput tags={pool} onChange={(t) => setSlot({ pool: t })} suggestions={[]} />
      </div>
      {pool.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowLevels(v => !v)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: C.brandInk, fontSize: 12.5, fontWeight: 700 }}>
            {showLevels ? "▾" : "▸"} Pin a specific word per level {pinnedCount > 0 ? `(${pinnedCount} pinned)` : "(optional)"}
          </button>
          {showLevels && (
            <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8 }}>
              {levelList.map(l => (
                <div key={l.level} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: C.sub, minWidth: 26 }}>L{l.level}</span>
                  <Select value={byLevel[l.level] ?? ""} aria-label={`Word for level ${l.level}`} title={`Word for level ${l.level}`} onChange={(e) => { const v = e.target.value; const nb = { ...byLevel }; if (v === "") delete nb[l.level]; else nb[l.level] = v; setSlot({ byLevel: nb }); }} style={{ padding: "5px 8px", fontSize: 12.5, flex: 1 }}>
                    <option value="">(vary)</option>
                    {pool.map(w => <option key={w} value={w}>{w}</option>)}
                  </Select>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function QuestionEditor({ question, packId, packLevel, levels, onSave, onClose }) {
  const isNew = !question?.id;
  const levelList = (levels && levels.length) ? levels : Array.from({ length: 10 }, (_, i) => ({ level: i + 1, name: "", hidden_mode: i >= 6 ? "word" : "letters" }));
  const [f, setF] = useState({
    template: question?.template || "I am {blank} when …",
    answer: question?.answer || "", alt_answer: question?.alt_answer || "",
    level: question?.level ?? null,
    letter_position: question?.letter_position ?? null,
    letter_grouping: question?.letter_grouping ?? null,
    status: question?.status || "active", notes: question?.notes || "",
    frame_slots: question?.frame_slots || {},
  });
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState({});
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const hasBlank = f.template.includes("{blank}");

  // The question's own base level (its override, or the pack's level).
  const baseLevel = f.level ?? packLevel ?? 1;
  // Which level to PREVIEW as (defaults to the base level; user can flip through any).
  const [previewLevel, setPreviewLevel] = useState(baseLevel);
  // Keep the preview level valid/sensible as the base level changes.
  useEffect(() => { setPreviewLevel(f.level ?? packLevel ?? 1); }, [f.level, packLevel]);

  const previewLvlDef = levelList.find(l => l.level === previewLevel) || levelList[0] || {};
  const previewHidesLetters = previewLvlDef.hidden_mode !== "word";

  // Build the real per-level variant for the previewed level, using the SAME engine the game
  // uses — so the editor preview matches exactly what the child will see.
  const previewVariant = useMemo(() => {
    const qForBuild = { template: f.template, answer: f.answer, alt_answer: f.alt_answer, frame_slots: f.frame_slots,
      letter_position: f.letter_position, letter_grouping: f.letter_grouping };
    const variants = buildLevelVariants(qForBuild, [previewLvlDef], {});
    return variants[0] || null;
  }, [f.template, f.answer, f.alt_answer, f.frame_slots, f.letter_position, f.letter_grouping, previewLvlDef]);

  // Detect frame-word tokens in the template ({token} where token !== blank).
  const frameTokens = [...new Set([...f.template.matchAll(/\{([a-zA-Z][\w-]*)\}/g)].map(m => m[1]).filter(t => t !== "blank"))];

  const submit = async () => {
    const e = {};
    if (!hasBlank) e.template = "Template must contain a {blank} token.";
    if (!f.answer.trim()) e.answer = "Enter the answer word.";
    setErrs(e); if (Object.keys(e).length) return;
    setBusy(true);
    // Only persist slots whose token still appears in the template.
    const cleanedSlots = {};
    for (const t of frameTokens) if (f.frame_slots[t]) cleanedSlots[t] = f.frame_slots[t];
    try {
      await onSave({ ...f, frame_slots: cleanedSlots, pack_id: packId,
        answer: f.answer.toUpperCase().trim(), alt_answer: f.alt_answer.toUpperCase().trim() }, question?.id);
      onClose();
    }
    catch (err) { setErrs({ form: err.message }); setBusy(false); }
  };
  useHotkey("mod+enter", submit, true);

  return (
    <>
      <ModalHead title={isNew ? "New question" : "Edit question"} subtitle="A fill-in-the-blank sentence with a positive answer" id="pm-q-title" />
      <div style={{ padding: S.xl + 2, display: "grid", gap: S.lg + 2, maxHeight: "64vh", overflowY: "auto" }}>
        <Field label="Sentence template" hint="Use {blank} for the word to guess. Add other {words} to make them swappable (e.g. …when things get {hard})." error={errs.template}>
          <Textarea value={f.template} onChange={(e) => set("template", e.target.value)} rows={2} placeholder="I am {blank} when I try something new." autoFocus
            style={{ borderColor: hasBlank ? C.line : C.danger }} />
        </Field>
        <div className="pm-form-2">
          <Field label="Answer (primary)" hint="Auto-uppercased" error={errs.answer}>
            <Input value={f.answer} onChange={(e) => set("answer", e.target.value)} placeholder="BRAVE" />
          </Field>
          <Field label="Second option" hint="The alternative positive word">
            <Input value={f.alt_answer} onChange={(e) => set("alt_answer", e.target.value)} placeholder="BOLD" />
          </Field>
        </div>

        <Field label="Level" hint="Sets how this question is hidden. Each level controls letters-vs-whole-word; you can override the pack's default here.">
          <Select value={f.level ?? ""} onChange={(e) => set("level", e.target.value === "" ? null : parseInt(e.target.value))}>
            <option value="">Inherit pack{packLevel ? ` (Level ${packLevel})` : ""}</option>
            {levelList.map(l => (
              <option key={l.level} value={l.level}>Level {l.level}{l.name ? ` — ${l.name}` : ""}{l.hidden_mode === "word" ? " (whole word)" : ""}</option>
            ))}
          </Select>
        </Field>

        {/* Preview — how the child actually sees it, at a level you can flip through */}
        <div style={{ background: C.brandSoft, borderRadius: R.lg, padding: `${S.lg}px ${S.lg + 2}px` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: C.brandInk, letterSpacing: 0.5 }}>HOW THE CHILD SEES IT</span>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11, fontWeight: 700, color: C.brandInk, opacity: 0.75 }}>Preview level:</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {levelList.map(l => {
                const on = l.level === previewLevel;
                const isBase = l.level === baseLevel;
                return (
                  <button key={l.level} type="button" onClick={() => setPreviewLevel(l.level)} title={`${l.name || "Level " + l.level}${isBase ? " · this question's level" : ""}${l.hidden_mode === "word" ? " · whole word" : ""}`}
                    style={{ padding: "3px 8px", borderRadius: R.pill, fontSize: 11.5, fontWeight: 800, cursor: "pointer", position: "relative",
                      border: "1px solid " + (on ? C.brand : (isBase ? C.brand + "88" : "transparent")),
                      background: on ? C.brand : "transparent", color: on ? "#fff" : C.brandInk }}>
                    {l.level}
                  </button>
                );
              })}
            </div>
          </div>
          <div style={{ fontSize: 17, color: C.ink, fontWeight: 500, lineHeight: 1.4 }}>{previewVariant?.sentence || "…"}</div>
          {previewVariant?.opts && <div style={{ fontSize: 14, color: C.brandInk, fontWeight: 800, marginTop: 8 }}>→ {previewVariant.opts}</div>}
          <div style={{ fontSize: 11.5, color: C.brandInk, opacity: 0.7, marginTop: 8 }}>
            {previewHidesLetters
              ? `This level hides ${previewVariant?.letters ?? "some"} letter${(previewVariant?.letters ?? 2) === 1 ? "" : "s"}.`
              : "This level hides the whole word."}
            {previewLevel === baseLevel ? " (this question's level)" : ""}
          </div>
        </div>

        {/* Per-question overrides of the level's letter placement — only relevant when the
            previewed level hides letters (not the whole word). */}
        {previewHidesLetters && (
          <div className="pm-form-2">
            <Field label="Missing letters position" hint="Override the level's placement for this question">
              <Select value={f.letter_position ?? ""} onChange={(e) => set("letter_position", e.target.value === "" ? null : e.target.value)}>
                <option value="">Inherit level ({previewLvlDef.letter_position || "end"})</option>
                <option value="start">Towards the start</option>
                <option value="middle">Towards the middle</option>
                <option value="end">Towards the end</option>
                <option value="random">Random</option>
              </Select>
            </Field>
            <Field label="When 2+ hidden" hint="Override the level's grouping for this question">
              <Select value={f.letter_grouping ?? ""} onChange={(e) => set("letter_grouping", e.target.value === "" ? null : e.target.value)}>
                <option value="">Inherit level ({previewLvlDef.letter_grouping || "grouped"})</option>
                <option value="grouped">Grouped together</option>
                <option value="spread">Spread apart</option>
              </Select>
            </Field>
          </div>
        )}

        {frameTokens.length > 0 && (
          <div style={{ border: "1px solid " + C.line, borderRadius: R.lg, padding: S.lg, display: "grid", gap: S.md }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, color: C.ink }}>Frame word variations</div>
              <div style={{ fontSize: 12.5, color: C.sub, marginTop: 2, lineHeight: 1.45 }}>These are swappable words in the sentence — <b>not</b> the word the child guesses. Give each a pool of alternatives, and optionally pin a specific one per level (useful for levels 7–10 where the blank stops changing).</div>
            </div>
            {frameTokens.map(token => {
              const slot = f.frame_slots[token] || { pool: [], byLevel: {} };
              const setSlot = (patch) => set("frame_slots", { ...f.frame_slots, [token]: { pool: slot.pool || [], byLevel: slot.byLevel || {}, ...patch } });
              return (
                <FrameSlotEditor key={token} token={token} slot={slot} setSlot={setSlot} levels={levels} />
              );
            })}
          </div>
        )}
        <Field label="Internal notes" hint="Optional — not shown to players">
          <Input value={f.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer" }}>
          <input type="checkbox" checked={f.status === "active"} onChange={(e) => set("status", e.target.checked ? "active" : "inactive")} style={{ width: 17, height: 17, accentColor: C.brand }} />
          <span style={{ fontSize: 13.5, color: C.ink, fontWeight: 600 }}>Active (included in the game)</span>
        </label>
        {errs.form && <ErrorState error={errs.form} />}
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy}>{busy ? "Saving…" : isNew ? "Add question" : "Save changes"}</Btn>
      </ModalFoot>
    </>
  );
}

// Bulk import — supports both the pipe format and pasted JSON
// Sanitize AI/user-supplied frame_slots from an import so only clean shapes reach the DB:
// { token: { pool: [strings], byLevel: { "level": "string" } } }. Returns null if nothing valid.
function sanitizeFrameSlots(fs) {
  if (!fs || typeof fs !== "object" || Array.isArray(fs)) return null;
  const out = {};
  for (const [token, slotRaw] of Object.entries(fs)) {
    if (!/^[a-zA-Z][\w-]*$/.test(token) || token === "blank") continue;
    const slot = (slotRaw && typeof slotRaw === "object" && !Array.isArray(slotRaw)) ? slotRaw : {};
    const pool = Array.isArray(slot.pool) ? slot.pool.filter(v => typeof v === "string" && v.trim()).map(v => v.trim()) : [];
    const byLevel = {};
    if (slot.byLevel && typeof slot.byLevel === "object" && !Array.isArray(slot.byLevel)) {
      for (const [lvl, w] of Object.entries(slot.byLevel)) {
        if (/^\d+$/.test(String(lvl)) && (typeof w === "string" || typeof w === "number") && String(w).trim()) byLevel[String(lvl)] = String(w).trim();
      }
    }
    if (pool.length || Object.keys(byLevel).length) out[token] = { pool, byLevel };
  }
  return Object.keys(out).length ? out : null;
}

function BulkImport({ packId, onDone, onClose, levels, packLevel }) {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [existing, setExisting] = useState([]);
  const [loadingExisting, setLoadingExisting] = useState(true);
  const [skipIds, setSkipIds] = useState(() => new Set()); // row indices the user chose to skip
  const [userTouched, setUserTouched] = useState(() => new Set()); // rows the user manually toggled

  // Vocabulary guidance from the pack's level (imported questions inherit the pack level). Purely
  // advisory — a word outside the band gets a soft warning, never blocks import.
  const levelDef = useMemo(() => (levels || []).find(l => l.level === (packLevel ?? 1)) || null, [levels, packLevel]);
  const bandCheck = (word) => {
    if (!levelDef) return null;
    const w = (word || "").replace(/\s+/g, "");
    const len = w.length;
    if (!len) return null;
    const wordCount = (word || "").trim().split(/\s+/).filter(Boolean).length;
    if (levelDef.min_word_len && len < levelDef.min_word_len) return `shorter than L${levelDef.level}'s ${levelDef.min_word_len}-letter minimum`;
    if (levelDef.max_word_len && len > levelDef.max_word_len) return `longer than L${levelDef.level}'s ${levelDef.max_word_len}-letter maximum`;
    if (wordCount > 1 && !levelDef.allow_multiword) return `L${levelDef.level} doesn't allow multi-word answers`;
    return null;
  };

  // Load the pack's existing questions so we can flag duplicates.
  useEffect(() => {
    let alive = true;
    setLoadingExisting(true);
    (async () => { try { const qs = await db.allQuestionsForPack(packId); if (alive) setExisting(qs || []); } catch { if (alive) setExisting([]); } finally { if (alive) setLoadingExisting(false); } })();
    return () => { alive = false; };
  }, [packId]);

  // Normalize a sentence for comparison: lowercase, blank/tokens collapsed, whitespace/punct trimmed.
  const normSentence = (t) => (t || "").toLowerCase().replace(/\{blank\}/g, "▢").replace(/\{[a-zA-Z][\w-]*\}/g, "▢").replace(/[^a-z0-9▢]+/g, " ").trim();
  // The validator needs the pack's existing content to catch duplicates and reused answer words.
  const existingForValidator = useMemo(
    () => (existing || []).map(q => ({ template: q.template, answer: q.answer, source: "live" })),
    [existing]
  );

  const existingIndex = useMemo(() => {
    const bySentence = new Map(); const byAnswer = new Map();
    for (const q of existing) {
      const ns = normSentence(q.template);
      if (!bySentence.has(ns)) bySentence.set(ns, []);
      bySentence.get(ns).push(q);
      for (const a of [q.answer, q.alt_answer].filter(Boolean)) {
        const k = a.toUpperCase(); if (!byAnswer.has(k)) byAnswer.set(k, []); byAnswer.get(k).push(q);
      }
    }
    return { bySentence, byAnswer };
  }, [existing]);

  const parsed = useMemo(() => {
    const txt = raw.trim();
    let rows = [];
    if (!txt) return [];
    if (txt.startsWith("[") || txt.startsWith("{")) {
      try {
        const j = JSON.parse(txt);
        const arr = Array.isArray(j) ? j : (j.questions || []);
        rows = arr.map(o => ({
          template: o.template || "", answer: (o.answer || "").toUpperCase(),
          alt_answer: (o.alt_answer || o.alt || "").toUpperCase(),
          frame_slots: sanitizeFrameSlots(o.frame_slots),
          ok: (o.template || "").includes("{blank}") && !!o.answer,
        }));
      } catch { return [{ template: "Invalid JSON", answer: "", alt_answer: "", ok: false, dup: "none" }]; }
    } else {
      rows = txt.split("\n").map(l => l.trim()).filter(Boolean).map(line => {
        const [t, a, alt] = line.split("|").map(s => (s || "").trim());
        return { template: t || "", answer: (a || "").toUpperCase(), alt_answer: (alt || "").toUpperCase(), ok: (t || "").includes("{blank}") && !!a };
      });
    }
    // Tag duplicates: exact = same sentence shape AND same answer word; near = same sentence OR same answer.
    const seenInBatch = new Set();
    return rows.map(r => {
      if (!r.ok) return { ...r, dup: "none" };
      const ns = normSentence(r.template);
      const ans = (r.answer || "").toUpperCase();
      const sentenceHits = existingIndex.bySentence.get(ns) || [];
      const answerHits = existingIndex.byAnswer.get(ans) || [];
      const exactExisting = sentenceHits.some(q => (q.answer || "").toUpperCase() === ans || (q.alt_answer || "").toUpperCase() === ans);
      const batchKey = ns + "|" + ans;
      const inBatchDup = seenInBatch.has(batchKey);
      seenInBatch.add(batchKey);
      let dup = "none";
      if (exactExisting || inBatchDup) dup = "exact";
      else if (sentenceHits.length || answerHits.length) dup = "near";
      // Run the SAME validator the AI pipeline uses, against the SAME rendering engine, at EVERY
      // level. Imported content is not special — a same-length alternate breaks the puzzle whether
      // a human typed it or an AI wrote it. (BRIGHT/GENTLE reached children through this exact
      // path.)
      const validation = validateQuestion(
        { template: r.template, answer: r.answer, alt_answer: r.alt_answer },
        levels || [],
        { targetLevel: packLevel, existing: existingForValidator }
      );
      return { ...r, dup, validation, bandWarn: bandCheck(r.answer), dupInfo: dup === "exact" ? (inBatchDup ? "duplicate within this batch" : "already in this pack") : (sentenceHits.length ? "same sentence exists" : "answer word already used") };
    });
  }, [raw, existingIndex, levelDef, existingForValidator, levels, packLevel]);

  // Default skip: exact duplicates are skipped unless the user un-skips them.
  useEffect(() => {
    setSkipIds(prev => {
      const next = new Set(prev);
      parsed.forEach((p, i) => { if (!userTouched.has(i)) { if (p.dup === "exact") next.add(i); else next.delete(i); } });
      return next;
    });
  }, [parsed, userTouched]);

  const toggleSkip = (i) => { setUserTouched(t => new Set(t).add(i)); setSkipIds(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; }); };

  const valid = parsed.filter(p => p.ok);
  const toImport = parsed.filter((p, i) => p.ok && !skipIds.has(i));
  const exactCount = parsed.filter(p => p.dup === "exact").length;
  const nearCount = parsed.filter(p => p.dup === "near").length;

  const submit = async () => {
    if (!toImport.length) { setErr("Nothing selected to import."); return; }
    setBusy(true); setErr("");
    try {
      // EVERYTHING goes to the review queue — never straight into the pack.
      //
      // There used to be two ways content got in and only one was gated: generation via API key went
      // to the queue, but pasting AI output here went STRAIGHT INTO THE LIVE PACK. Same AI, same
      // risks, no gate. That is the exact path by which BRIGHT/GENTLE (two same-length words, so
      // both fit the blank) reached children.
      //
      // We do not try to guess whether a paste "came from AI" — we usually cannot tell, and a wrong
      // guess means unchecked content reaches a child. So it all goes through the gate.
      const res = await rpc("pm_review_enqueue", {
        p_pack_id: packId,
        p_items: toImport.map(v => ({
          template: v.template,
          answer: v.answer,
          alt_answer: v.alt_answer,
          ...(v.frame_slots ? { frame_slots: v.frame_slots } : {}),
          validation: v.validation || null,
        })),
        p_source: "import",
        p_target_level: packLevel ?? null,
      });
      const n = res?.queued ?? toImport.length;
      const flagged = toImport.filter(v => v.validation && !v.validation.ok).length;
      notify(
        flagged
          ? `${n} question${n === 1 ? "" : "s"} sent for review — ${flagged} flagged`
          : `${n} question${n === 1 ? "" : "s"} sent for review`
      );
      onDone && onDone(n);
      onClose();
    } catch (e) { setErr(friendlyError(0, String(e?.message || e))); setBusy(false); }
  };

  const dupStyle = { exact: { fg: C.danger, label: "Duplicate" }, near: { fg: C.warn, label: "Similar" }, none: null };

  return (
    <>
      <ModalHead title="Import questions" subtitle="Everything you import goes to AI Review for your approval" id="pm-imp-title" />
      <div style={{ padding: S.xl + 2, display: "grid", gap: S.md + 2 }}>
        <div className="pm-readable" style={{ fontSize: 12.5, color: C.brandInk, background: C.brandSoft,
          padding: "10px 13px", borderRadius: R.md, lineHeight: 1.55 }}>
          <b>These go to AI Review, not straight into the pack.</b> Every question is checked against
          the real game engine first — including whether the two words are the same length, which would
          give the child <i>two correct answers</i>. Approve them from <b>AI Review</b> when you're happy.
        </div>

        <div style={{ fontSize: 12.5, color: C.sub, background: C.lineSoft, padding: "8px 12px", borderRadius: R.sm, lineHeight: 1.5 }}>
          <b>Pipe:</b> <code>Sentence with {"{blank}"} | ANSWER | ALT</code><br />
          <b>JSON:</b> <code>{'[{"template":"…{blank}…","answer":"BRAVE","alt_answer":"BOLD"}]'}</code>
          {levelDef && (levelDef.min_word_len || levelDef.max_word_len || levelDef.allow_multiword) && (
            <><br /><span style={{ color: C.faint }}>Pack level {levelDef.level} suggests {levelDef.min_word_len && levelDef.max_word_len ? `${levelDef.min_word_len}–${levelDef.max_word_len}-letter` : levelDef.min_word_len ? `${levelDef.min_word_len}+ letter` : levelDef.max_word_len ? `≤${levelDef.max_word_len}-letter` : ""} words{levelDef.allow_multiword ? ", multi-word ok" : ""}. Out-of-range words get a soft “Length” flag (still importable).</span></>
          )}
        </div>
        <Textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={7} autoFocus aria-label="Paste questions to import" placeholder={"I am {blank} when I try something new. | BRAVE | BOLD\nBeing {blank} helps me make friends. | KIND | CARING"} style={{ fontFamily: "ui-monospace, monospace", fontSize: 13 }} />
        {raw.trim() && (
          <div style={{ background: C.bg, borderRadius: R.md, padding: S.md + 2, maxHeight: 260, overflowY: "auto" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.sub, marginBottom: 8, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <span>{toImport.length} to import · {valid.length - toImport.length} skipped · {parsed.length - valid.length} invalid</span>
              {loadingExisting ? <span style={{ color: C.faint }}>● checking for duplicates…</span> : <>
                {exactCount > 0 && <span style={{ color: C.danger }}>● {exactCount} duplicate{exactCount === 1 ? "" : "s"}</span>}
                {nearCount > 0 && <span style={{ color: C.warn }}>● {nearCount} similar</span>}
              </>}
            </div>
            {parsed.map((p, i) => {
              const ds = dupStyle[p.dup];
              const skipped = skipIds.has(i);
              return (
                <div key={i} style={{ fontSize: 13, padding: "6px 0", color: !p.ok ? C.faint : skipped ? C.faint : C.ink, display: "flex", gap: 8, alignItems: "center", borderBottom: "1px solid " + C.line, opacity: skipped ? 0.6 : 1 }}>
                  <span style={{ color: p.ok ? C.good : C.danger, fontWeight: 800 }}>{p.ok ? "✓" : "✕"}</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textDecoration: skipped ? "line-through" : "none" }}>{p.template.replace(/\{blank\}/g, "___").replace(/\{([a-zA-Z][\w-]*)\}/g, "$1") || <em>empty</em>}</span>
                  {p.ok && <span style={{ color: C.brandInk, fontWeight: 700, fontSize: 12 }}>{[p.answer, p.alt_answer].filter(Boolean).join(" / ")}</span>}
                  {ds && <span title={p.dupInfo} style={{ color: ds.fg, fontWeight: 700, fontSize: 11, padding: "1px 7px", borderRadius: R.pill, border: "1px solid " + ds.fg + "66", whiteSpace: "nowrap" }}>{ds.label}</span>}
                  {p.ok && p.bandWarn && <span title={p.bandWarn} style={{ color: C.warn, fontWeight: 700, fontSize: 11, padding: "1px 7px", borderRadius: R.pill, border: "1px solid " + C.warn + "66", whiteSpace: "nowrap" }}>Length</span>}
                  {/* Show what the real engine found, BEFORE you commit — not after. The important
                      one is "Two answers": both words the same length, so both fit the blank. */}
                  {p.ok && p.validation && !p.validation.ok && p.validation.flags.map((fl, fi) => {
                    const hard = fl.code === "ambiguous" || fl.code === "same_word" || fl.code === "no_blank" || fl.code === "multi_blank";
                    const col = hard ? C.danger : C.warn;
                    const label = fl.code === "ambiguous" ? "Two answers"
                      : fl.code === "same_word" ? "Same word"
                      : fl.code === "no_blank" ? "No blank"
                      : fl.code === "multi_blank" ? "Too many blanks"
                      : fl.code === "duplicate" ? "Duplicate"
                      : fl.code;
                    return (
                      <span key={fi} title={fl.detail} style={{ color: col, fontWeight: 700, fontSize: 11,
                        padding: "1px 7px", borderRadius: R.pill, border: "1px solid " + col + "66", whiteSpace: "nowrap" }}>
                        {label}
                      </span>
                    );
                  })}
                  {p.ok && p.dup !== "none" && (
                    <button type="button" onClick={() => toggleSkip(i)} style={{ background: "none", border: "1px solid " + C.line, borderRadius: R.sm, padding: "2px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer", color: C.sub, whiteSpace: "nowrap" }}>
                      {skipped ? "Keep" : "Skip"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {err && <ErrorState error={err} />}
      </div>
      <ModalFoot>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy || !toImport.length || loadingExisting}>{busy ? "Sending…" : loadingExisting ? "Checking…" : `Send ${toImport.length} for review`}</Btn>
      </ModalFoot>
    </>
  );
}
